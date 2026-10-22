#!/usr/bin/env python3
"""Offline ASR + session-wide speaker diarization. See docs/transcript.md."""

import argparse
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

# Set before importing any inference/download libraries. No model IDs are passed
# to inference APIs: only the verified local model directory is used.
for _key, _value in {
    "HF_HUB_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1",
    "TRANSFORMERS_OFFLINE": "1", "DO_NOT_TRACK": "1",
    "TOKENIZERS_PARALLELISM": "false",
    "OMP_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "2",
    "MKL_NUM_THREADS": "2", "VECLIB_MAXIMUM_THREADS": "2",
}.items():
    os.environ[_key] = _value

RATE = 16000
MAX_AUDIO_SECONDS = 12 * 60 * 60
MAX_MANIFEST_BYTES = 512 * 1024
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
WHISPER_REVISION = "536b0662742c02347bc0e980a01041f333bce120"
SEGMENTATION = "sherpa-onnx-pyannote-segmentation-3-0/model.onnx"
EMBEDDING = "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"


class TranscriptError(Exception):
    pass


class Interrupted(TranscriptError):
    pass


@dataclass(frozen=True)
class Span:
    recording_id: str
    start: float  # concatenated PCM timeline
    end: float
    offset: float  # original wall-clock offset from session start


def progress(phase, value=None):
    item = {"phase": phase}
    if value is not None:
        item["progress"] = round(max(0.0, min(1.0, value)) * 100, 2)
    print(json.dumps(item, allow_nan=False), flush=True)


def finite_number(value, name, minimum=0, maximum=MAX_AUDIO_SECONDS):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TranscriptError(f"{name} must be a finite number")
    if not math.isfinite(value) or value < minimum or value > maximum:
        raise TranscriptError(f"{name} must be between {minimum} and {maximum}")
    return float(value)


def validate_manifest(value):
    if not isinstance(value, dict):
        raise TranscriptError("Manifest must be a JSON object")
    job_id = value.get("jobId")
    if not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", job_id):
        raise TranscriptError("Invalid jobId")
    language = value.get("language", "auto")
    if not isinstance(language, str) or not re.fullmatch(r"auto|[a-z]{2,3}", language):
        raise TranscriptError("language must be auto or a lowercase ISO language code")
    speakers = value.get("numSpeakers")
    if speakers is not None and (type(speakers) is not int or not 1 <= speakers <= 20):
        raise TranscriptError("numSpeakers must be null or an integer from 1 to 20")
    recordings = value.get("recordings")
    if not isinstance(recordings, list) or not 1 <= len(recordings) <= 1000:
        raise TranscriptError("recordings must contain 1–1000 local files")
    ids, result, total = set(), [], 0.0
    last_offset = -1.0
    for index, item in enumerate(recordings):
        if not isinstance(item, dict):
            raise TranscriptError(f"recordings[{index}] must be an object")
        recording_id = item.get("id")
        if not isinstance(recording_id, str) or not recording_id or len(recording_id) > 255 or recording_id in ids:
            raise TranscriptError("Recording IDs must be unique nonempty strings (max 255 characters)")
        filename = item.get("file")
        if not isinstance(filename, str) or not Path(filename).is_absolute() or "\0" in filename:
            raise TranscriptError("Recording file must be an absolute local path")
        duration = finite_number(item.get("duration"), "duration", 0.01)
        offset = finite_number(item.get("offsetSeconds"), "offsetSeconds", maximum=7 * 24 * 3600)
        if offset < last_offset:
            raise TranscriptError("Recordings must be ordered by offsetSeconds")
        last_offset = offset
        total += duration
        ids.add(recording_id)
        result.append({**item, "duration": duration, "offsetSeconds": offset})
    if total > MAX_AUDIO_SECONDS:
        raise TranscriptError("At most 12 hours of recorded audio may be transcribed in one job")
    return {"jobId": job_id, "language": language, "numSpeakers": speakers, "recordings": result}


class Timeline:
    def __init__(self, spans):
        self.spans = spans
        self.starts = [span.start for span in spans]

    def map_word(self, start, end):
        """Choose maximum-overlap source; clip a seam word, never duplicate text."""
        if not self.spans or not math.isfinite(start + end) or end <= start:
            return None
        first = max(0, bisect_right(self.starts, start) - 1)
        candidates = []
        for span in self.spans[first:]:
            if span.start >= end:
                break
            overlap = min(end, span.end) - max(start, span.start)
            if overlap > 0:
                candidates.append((overlap, span))
        if not candidates:
            return None
        span = max(candidates, key=lambda entry: entry[0])[1]
        return (span.recording_id, span.offset + max(start, span.start) - span.start,
                span.offset + min(end, span.end) - span.start)


class SpeakerTurns:
    def __init__(self, turns):
        self.turns = sorted(turns, key=lambda turn: (turn["start"], turn["end"], turn["speaker"]))
        self.starts = [turn["start"] for turn in self.turns]
        self.max_ends = []
        end = -math.inf
        for turn in self.turns:
            end = max(end, turn["end"])
            self.max_ends.append(end)

    def near(self, start, end, tolerance=0.35):
        low = bisect_left(self.max_ends, start - tolerance)
        high = bisect_right(self.starts, end + tolerance)
        return self.turns[low:high]

    def assign(self, start, end):
        if not math.isfinite(start + end) or end <= start:
            return None
        scores = {}
        candidates = self.near(start, end)
        for turn in candidates:
            overlap = max(0.0, min(end, turn["end"]) - max(start, turn["start"]))
            scores[turn["speaker"]] = scores.get(turn["speaker"], 0.0) + overlap
        if scores and max(scores.values()) > 0:
            # Dict insertion order makes equal-overlap ties prefer the earlier turn.
            return max(scores, key=scores.get)
        if candidates:
            # Timestamp estimates at word boundaries can differ slightly. Do not
            # assign speech far from any detected voice to an arbitrary speaker.
            nearest = min(candidates, key=lambda t: max(t["start"] - end, start - t["end"], 0))
            if max(nearest["start"] - end, start - nearest["end"], 0) <= 0.35:
                return nearest["speaker"]
        return None


def assemble_segments(words, turns, spans, diagnostics=None):
    timeline, diarization = Timeline(spans), SpeakerTurns(turns)
    segments, labels, skipped = [], {}, 0
    support, unknown_words = {}, 0
    for word in sorted(words, key=lambda item: (item["start"], item["end"])):
        text = word["text"]
        if not text.strip():
            continue
        start, end = word["start"], word["end"]
        mapped = timeline.map_word(start, end)
        speaker = diarization.assign(start, end)
        if mapped is None:
            skipped += 1
            continue
        recording_id, start, end = mapped
        if speaker is None:
            # Recognition and speaker matching are independent: retain valid
            # recognized words rather than discarding speech or inventing a voice.
            speaker_id = None
            unknown_words += 1
        else:
            if speaker not in labels:
                labels[speaker] = f"speaker_{len(labels) + 1}"
            speaker_id = labels[speaker]
            support[speaker_id] = support.get(speaker_id, 0.0) + end - start
        previous = segments[-1] if segments else None
        if (previous and previous["speakerId"] == speaker_id and
                previous["recordingId"] == recording_id and
                start - previous["end"] <= 1.2 and end - previous["start"] <= 20):
            previous["end"] = max(previous["end"], end)
            previous["text"] += text
        else:
            segments.append({"start": start, "end": end, "speakerId": speaker_id,
                             "text": text, "recordingId": recording_id})
    for item in segments:
        item["start"] = round(item["start"], 3)
        item["end"] = round(max(item["end"], item["start"] + 0.001), 3)
        item["text"] = item["text"].strip()
    # Explicit source offsets may slightly overlap after container timestamp
    # rounding. Preserve those offsets but publish chronological output.
    segments.sort(key=lambda item: (item["start"], item["end"]))
    speakers = [{"id": value, "label": f"Speaker {index + 1}"} for index, value in enumerate(labels.values())]
    if diagnostics is not None:
        diagnostics.update(speakerSupportSeconds=support, unknownWords=unknown_words)
    return segments, speakers, skipped


def speaker_quality_warnings(speakers, diagnostics):
    warnings = []
    if speakers:
        warnings.append("Speaker count and labels are acoustic estimates, not verified participant counts or real identities.")
    for speaker in speakers:
        support = diagnostics.get("speakerSupportSeconds", {}).get(speaker["id"], 0.0)
        if support < 1:
            warnings.append(f"Low-support speaker: {speaker['label']} has only {support:.2f} s of aligned speech; this may be a spurious split. No automatic merge was applied.")
    unknown = diagnostics.get("unknownWords", 0)
    if unknown:
        warnings.append(f"Kept {unknown} words without a reliable speaker match as speakerId=null (Unknown speaker).")
    return warnings


def extract_audio(recordings, destination, warnings):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise TranscriptError("ffmpeg is missing from PATH")
    needed = int(sum(item["duration"] + 1 for item in recordings) * RATE * 4)
    if shutil.disk_usage(destination.parent).free < needed + 1024 ** 3:
        raise TranscriptError("Insufficient temporary disk space for 16 kHz mono audio (plus 1 GiB reserve)")
    spans = []
    with destination.open("xb") as output, tempfile.TemporaryFile() as errors:
        os.chmod(destination, 0o600)
        for index, item in enumerate(recordings):
            filename = Path(item["file"])
            if not filename.is_file():
                raise TranscriptError(f"Recording file is missing: {item['id']}")
            initial_size = output.tell()
            errors.seek(0)
            errors.truncate()
            # Fixed argv, no shell; only local file/pipe protocols may be decoded.
            command = [ffmpeg, "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
                       "-i", str(filename), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(RATE),
                       "-t", str(item["duration"] + 1), "-f", "f32le", "pipe:1"]
            child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output, stderr=errors)
            try:
                code = child.wait(timeout=max(60, min(3600, item["duration"] * 4)))
            finally:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
            output.seek(0, os.SEEK_END)
            if code != 0:
                errors.seek(max(0, errors.tell() - 1500))
                detail = errors.read(1500).decode("utf-8", errors="replace").strip()
                raise TranscriptError(f"Audio extraction failed for {item['id']}: {detail}")
            sample_count = (output.tell() - initial_size) // 4
            duration = sample_count / RATE
            if duration < 0.01:
                raise TranscriptError(f"No decodable audio in {item['id']}")
            if duration >= item["duration"] + 0.95:
                raise TranscriptError(f"Audio exceeds manifest duration for {item['id']}; refresh recording metadata")
            if abs(duration - item["duration"]) > 0.1:
                warnings.append(f"Decoded duration differs from metadata for {item['id']}; timestamps use decoded audio.")
            start = initial_size / (RATE * 4)
            spans.append(Span(item["id"], start, start + duration, item["offsetSeconds"]))
            progress("extracting", (index + 1) / len(recordings))
    for previous, following in zip(spans, spans[1:]):
        if previous.offset + previous.end - previous.start > following.offset + 0.1:
            warnings.append("Source recording wall-clock ranges overlap; original offsets are preserved.")
            break
    return spans


def ensure_models(models):
    paths = [models / "faster-whisper-small" / name for name in
             ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")]
    paths += [models / SEGMENTATION, models / EMBEDDING]
    if any(not path.is_file() or path.stat().st_size == 0 for path in paths):
        raise TranscriptError("Local models are incomplete. Run pnpm run transcript:setup first; runtime never downloads models.")


def diarize(audio, models, num_speakers):
    import sherpa_onnx
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=str(models / SEGMENTATION), window_shift_ratio=0.1),
            num_threads=2, provider="cpu", debug=False),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=str(models / EMBEDDING), num_threads=2, provider="cpu", debug=False),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=num_speakers or -1, threshold=0.5),
        min_duration_on=0.3, min_duration_off=0.5,
    )
    if not config.validate():
        raise TranscriptError("Invalid local speaker diarization model configuration")
    engine = sherpa_onnx.OfflineSpeakerDiarization(config)
    if engine.sample_rate != RATE:
        raise TranscriptError("Unexpected diarization model sample rate")
    last_report = [-1]

    def callback(done, total):
        percent = int(100 * done / max(1, total))
        if percent != last_report[0]:
            progress("diarizing", percent / 100)
            last_report[0] = percent
        return 0

    result = engine.process(audio, callback=callback).sort_by_start_time()
    return [{"start": float(turn.start), "end": float(turn.end), "speaker": int(turn.speaker)} for turn in result]


def recognize(audio, models, language, turns):
    from faster_whisper import WhisperModel
    engine = WhisperModel(str(models / "faster-whisper-small"), device="cpu", compute_type="int8",
                          cpu_threads=min(2, os.cpu_count() or 1), num_workers=1, local_files_only=True)
    detected = None if language == "auto" else language
    words = []
    duration = len(audio) / RATE
    index = SpeakerTurns(turns)
    # Bounded five-minute ASR windows, with overlap and midpoint ownership. The
    # diarization above is still one full-session clustering pass.
    for start in range(0, math.ceil(duration), 300):
        end = min(duration, start + 300)
        if not index.near(start, end, tolerance=0):
            progress("transcribing", end / duration)
            continue
        padded_start, padded_end = max(0, start - 1), min(duration, end + 1)
        segments, info = engine.transcribe(
            audio[int(padded_start * RATE):int(padded_end * RATE)], language=detected,
            task="transcribe", beam_size=5, word_timestamps=True,
            vad_filter=True, vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 200},
            condition_on_previous_text=False, hallucination_silence_threshold=2,
            temperature=0.0, log_progress=False,
        )
        for segment in segments:
            for word in segment.words or []:
                word_start, word_end = padded_start + word.start, padded_start + word.end
                midpoint = (word_start + word_end) / 2
                if start <= midpoint < end and word_end > word_start:
                    words.append({"start": word_start, "end": word_end, "text": word.word})
                    if len(words) > 250_000:
                        raise TranscriptError("Transcript exceeded the 250000-word safety limit")
            progress("transcribing", min(end, padded_start + segment.end) / duration)
        if words and detected is None:
            detected = info.language
        progress("transcribing", end / duration)
    return words, detected or "und"


def atomic_json(filename, value):
    data = (json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
    if len(data) > MAX_OUTPUT_BYTES:
        raise TranscriptError("Transcript exceeded the 16 MiB output limit")
    filename.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{filename.name}.", suffix=".tmp", dir=filename.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, filename)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def offline_audit(event, args):
    if event in {"socket.connect", "socket.getaddrinfo", "urllib.Request", "http.client.connect"}:
        raise TranscriptError("Network access is disabled during local transcription")


def transcribe(manifest, output, models):
    started = time.monotonic()
    ensure_models(models)
    try:
        import numpy as np
    except ImportError as error:
        raise TranscriptError("Local inference dependencies are missing. Run pnpm run transcript:setup.") from error
    warnings = []
    progress("extracting", 0)
    # Temp audio stays beside the job output (normally inside ignored private
    # runtime state), never in a cloud/transcription provider's cache.
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".transcript-audio-", dir=output.parent) as temporary:
        pcm = Path(temporary) / "session.f32"
        spans = extract_audio(manifest["recordings"], pcm, warnings)
        audio = np.memmap(pcm, dtype="<f4", mode="r")
        try:
            has_signal = any(float(np.max(np.abs(audio[start:start + RATE * 60]))) > 0.00003
                             for start in range(0, len(audio), RATE * 60))
            progress("diarizing", 0)
            turns = diarize(audio, models, manifest["numSpeakers"]) if has_signal else []
            if turns:
                words, language = recognize(audio, models, manifest["language"], turns)
                alignment = {}
                segments, speakers, skipped = assemble_segments(words, turns, spans, alignment)
                warnings.extend(speaker_quality_warnings(speakers, alignment))
                if skipped:
                    warnings.append(f"Omitted {skipped} words outside the valid source recording timeline.")
                previous_end, previous_speaker = -1.0, None
                for turn in turns:
                    if turn["start"] < previous_end and turn["speaker"] != previous_speaker:
                        warnings.append("Overlapping voices detected; each word is assigned to its strongest overlap, not separated audio.")
                        break
                    if turn["end"] > previous_end:
                        previous_end, previous_speaker = turn["end"], turn["speaker"]
            else:
                segments, speakers = [], []
                language = "und" if manifest["language"] == "auto" else manifest["language"]
            if not segments:
                warnings.append("No intelligible speech detected; transcript is empty.")
            result = {
                "jobId": manifest["jobId"], "language": language,
                "duration": round(max(span.offset + span.end - span.start for span in spans), 3),
                "speakers": speakers, "segments": segments,
                "engine": {
                    "asr": "faster-whisper", "asrVersion": importlib.metadata.version("faster-whisper"),
                    "model": "small", "modelRevision": WHISPER_REVISION,
                    "diarization": "sherpa-onnx", "diarizationVersion": importlib.metadata.version("sherpa-onnx"),
                    "segmentation": "pyannote-segmentation-3.0", "embedding": "3dspeaker-eres2net-base",
                    "device": "cpu", "computeType": "int8", "offline": True,
                    "pipelineVersion": 2,
                    "elapsedSeconds": round(time.monotonic() - started, 3),
                },
                "warnings": warnings,
            }
            progress("exporting", 0)
            atomic_json(output, result)
        finally:
            audio._mmap.close()
    progress("completed", 1)


def cancel(signum, frame):
    raise Interrupted("Transcription cancelled")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--models", type=Path, required=True)
    args = parser.parse_args(argv)
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, cancel)
    sys.addaudithook(offline_audit)
    try:
        progress("validating", 0)
        if args.manifest.stat().st_size > MAX_MANIFEST_BYTES:
            raise TranscriptError("Manifest exceeds 512 KiB")
        manifest = validate_manifest(json.loads(args.manifest.read_text(encoding="utf-8")))
        target = args.output.resolve()
        inputs = [args.manifest.resolve(), *(Path(item["file"]).resolve() for item in manifest["recordings"])]
        if target in inputs or target.is_relative_to(args.models.resolve()):
            raise TranscriptError("Output must not overwrite an input recording, manifest, or model file")
        transcribe(manifest, args.output.resolve(), args.models.resolve())
        return 0
    except Interrupted as error:
        print(str(error), file=sys.stderr)
        return 130
    except Exception as error:
        print(f"Local transcript failed: {str(error)[:2000]}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
