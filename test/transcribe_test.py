#!/usr/bin/env python3
"""Model-free unit tests; --smoke additionally runs local synthetic inference."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import wave

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("meeting_mate_transcribe", ROOT / "scripts/transcribe.py")
TRANSCRIBE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = TRANSCRIBE
SPEC.loader.exec_module(TRANSCRIBE)


def manifest(**changes):
    return {"jobId": "unit-test", "language": "auto", "numSpeakers": None,
            "recordings": [{"id": "part-1.mp4", "file": "/tmp/synthetic.mp4", "duration": 10,
                            "startedAt": "2026-10-22T00:00:00Z", "endedAt": "2026-10-22T00:00:10Z",
                            "offsetSeconds": 0}], **changes}


class ManifestTest(unittest.TestCase):
    def test_accepts_optional_automatic_speaker_count(self):
        result = TRANSCRIBE.validate_manifest(manifest())
        self.assertEqual(result["recordings"][0]["duration"], 10)
        self.assertIsNone(result["numSpeakers"])

    def test_rejects_invalid_count(self):
        for count in [0, -1, 21, 32, True, "2", 2.5]:
            with self.subTest(count=count), self.assertRaises(TRANSCRIBE.TranscriptError):
                TRANSCRIBE.validate_manifest(manifest(numSpeakers=count))

    def test_rejects_invalid_language_and_job_id(self):
        for change in [{"language": "zh-TW"}, {"language": None}, {"jobId": "../x"}, {"jobId": ""}]:
            with self.subTest(change=change), self.assertRaises(TRANSCRIBE.TranscriptError):
                TRANSCRIBE.validate_manifest(manifest(**change))

    def test_rejects_remote_relative_and_nonfinite_inputs(self):
        for field, value in [("file", "https://example.org/private.wav"), ("file", "relative.wav"),
                             ("duration", float("nan")), ("duration", float("inf")), ("duration", -2),
                             ("offsetSeconds", -1), ("offsetSeconds", True)]:
            item = manifest()
            item["recordings"][0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(TRANSCRIBE.TranscriptError):
                TRANSCRIBE.validate_manifest(item)

    def test_rejects_duplicates_unsorted_and_too_long(self):
        first = manifest()["recordings"][0]
        for recordings in [[first, first], [dict(first, offsetSeconds=20), dict(first, id="second", offsetSeconds=0)],
                           [dict(first, duration=30000), dict(first, id="second", duration=30000, offsetSeconds=30000)]]:
            with self.subTest(recordings=recordings), self.assertRaises(TRANSCRIBE.TranscriptError):
                TRANSCRIBE.validate_manifest(manifest(recordings=recordings))


class TimelineTest(unittest.TestCase):
    def setUp(self):
        self.timeline = TRANSCRIBE.Timeline([TRANSCRIBE.Span("one", 0, 10, 0), TRANSCRIBE.Span("two", 10, 20, 40)])

    def test_pause_gap_is_not_removed_from_output(self):
        self.assertEqual(self.timeline.map_word(12, 13), ("two", 42, 43))

    def test_seam_word_keeps_only_maximum_overlap_source(self):
        self.assertEqual(self.timeline.map_word(9.8, 10.5), ("two", 40, 40.5))
        self.assertEqual(self.timeline.map_word(9.5, 10.1), ("one", 9.5, 10))

    def test_exact_boundary_belongs_to_following_file(self):
        self.assertEqual(self.timeline.map_word(10, 10.5), ("two", 40, 40.5))

    def test_invalid_and_outside_words_are_not_invented(self):
        for start, end in [(20, 21), (3, 2), (5, 5), (float("nan"), 5), (-3, -1)]:
            self.assertIsNone(self.timeline.map_word(start, end))

    def test_initial_session_offset_is_preserved(self):
        timeline = TRANSCRIBE.Timeline([TRANSCRIBE.Span("late", 0, 5, 120)])
        self.assertEqual(timeline.map_word(1, 2), ("late", 121, 122))


class SpeakerTest(unittest.TestCase):
    def test_assignment_uses_total_overlap_not_cluster_number(self):
        turns = TRANSCRIBE.SpeakerTurns([
            {"start": 0, "end": 0.4, "speaker": 8}, {"start": 0.4, "end": 0.7, "speaker": 3},
            {"start": 0.7, "end": 1, "speaker": 8}])
        self.assertEqual(turns.assign(0, 1), 8)

    def test_equal_overlap_prefers_first_voice_deterministically(self):
        turns = TRANSCRIBE.SpeakerTurns([{"start": 0, "end": 1, "speaker": 9},
                                         {"start": 1, "end": 2, "speaker": 1}])
        self.assertEqual(turns.assign(0.5, 1.5), 9)

    def test_boundary_tolerance_does_not_label_distant_silence(self):
        turns = TRANSCRIBE.SpeakerTurns([{"start": 1, "end": 2, "speaker": 7}])
        self.assertEqual(turns.assign(2.1, 2.2), 7)
        self.assertIsNone(turns.assign(4, 5))

    def test_nested_overlap_is_found_by_interval_index(self):
        turns = TRANSCRIBE.SpeakerTurns([{"start": 0, "end": 10, "speaker": 8},
                                         {"start": 1, "end": 2, "speaker": 2},
                                         {"start": 3, "end": 4, "speaker": 2}])
        self.assertEqual(turns.assign(8, 9), 8)

    def test_numbering_follows_first_retained_voice_and_is_stable_across_files(self):
        spans = [TRANSCRIBE.Span("a", 0, 4, 0), TRANSCRIBE.Span("b", 4, 8, 10)]
        turns = [{"start": 0, "end": 1, "speaker": 17}, {"start": 1, "end": 4, "speaker": 2},
                 {"start": 4, "end": 5, "speaker": 17}]
        words = [{"start": 0, "end": 0.5, "text": "Hello"}, {"start": 2, "end": 2.5, "text": " world"},
                 {"start": 4, "end": 4.5, "text": " Again"}]
        segments, speakers, skipped = TRANSCRIBE.assemble_segments(words, turns, spans)
        self.assertEqual([item["speakerId"] for item in segments], ["speaker_1", "speaker_2", "speaker_1"])
        self.assertEqual(segments[2]["start"], 10)
        self.assertEqual(speakers, [{"id": "speaker_1", "label": "Speaker 1"}, {"id": "speaker_2", "label": "Speaker 2"}])
        self.assertEqual(skipped, 0)

    def test_never_merges_across_recording_boundary(self):
        spans = [TRANSCRIBE.Span("a", 0, 2, 0), TRANSCRIBE.Span("b", 2, 4, 2)]
        turns = [{"start": 0, "end": 4, "speaker": 0}]
        words = [{"start": 1, "end": 2, "text": "first"}, {"start": 2, "end": 3, "text": " second"}]
        segments, _, _ = TRANSCRIBE.assemble_segments(words, turns, spans)
        self.assertEqual(len(segments), 2)

    def test_empty_speech_stays_empty(self):
        result = TRANSCRIBE.assemble_segments([], [], [TRANSCRIBE.Span("a", 0, 2, 0)])
        self.assertEqual(result, ([], [], 0))

    def test_words_without_speaker_match_are_preserved_as_unknown(self):
        words = [{"start": 0, "end": 1, "text": "Recognized speech"}]
        diagnostics = {}
        result = TRANSCRIBE.assemble_segments(words, [], [TRANSCRIBE.Span("a", 0, 2, 0)], diagnostics)
        self.assertEqual(result, ([{"start": 0, "end": 1, "speakerId": None, "text": "Recognized speech", "recordingId": "a"}], [], 0))
        self.assertEqual(diagnostics["unknownWords"], 1)
        self.assertIn("speakerId=null", TRANSCRIBE.speaker_quality_warnings([], diagnostics)[0])

    def test_only_words_outside_source_timeline_are_dropped(self):
        words = [{"start": 5, "end": 6, "text": "outside"}]
        result = TRANSCRIBE.assemble_segments(words, [], [TRANSCRIBE.Span("a", 0, 2, 0)])
        self.assertEqual(result, ([], [], 1))

    def test_unknown_voice_does_not_consume_a_speaker_number(self):
        words = [{"start": 0, "end": 1, "text": "unknown"}, {"start": 3, "end": 4, "text": " known"}]
        turns = [{"start": 3, "end": 4, "speaker": 55}]
        segments, speakers, _ = TRANSCRIBE.assemble_segments(words, turns, [TRANSCRIBE.Span("a", 0, 5, 0)])
        self.assertEqual([segment["speakerId"] for segment in segments], [None, "speaker_1"])
        self.assertEqual(speakers, [{"id": "speaker_1", "label": "Speaker 1"}])

    def test_tiny_speakers_are_warned_not_merged(self):
        words = [{"start": 0, "end": 0.26, "text": "嗯"}, {"start": 1, "end": 3, "text": "normal speech"}]
        turns = [{"start": 0, "end": 0.3, "speaker": 3}, {"start": 1, "end": 3, "speaker": 77}]
        diagnostics = {}
        segments, speakers, _ = TRANSCRIBE.assemble_segments(words, turns, [TRANSCRIBE.Span("a", 0, 5, 0)], diagnostics)
        self.assertEqual(len(speakers), 2)
        self.assertEqual(len(segments), 2)
        warnings = TRANSCRIBE.speaker_quality_warnings(speakers, diagnostics)
        self.assertTrue(any("estimates" in message for message in warnings))
        self.assertTrue(any("Speaker 1" in message and "0.26 s" in message for message in warnings))
        self.assertFalse(any("Low-support speaker: Speaker 2" in message for message in warnings))

    def test_support_uses_word_duration_not_gaps_between_words(self):
        words = [{"start": 0, "end": 0.2, "text": "one"}, {"start": 1, "end": 1.2, "text": " two"}]
        diagnostics = {}
        _, speakers, _ = TRANSCRIBE.assemble_segments(words, [{"start": 0, "end": 2, "speaker": 5}],
                                                      [TRANSCRIBE.Span("a", 0, 3, 0)], diagnostics)
        self.assertAlmostEqual(diagnostics["speakerSupportSeconds"]["speaker_1"], 0.4)
        self.assertTrue(any("0.40 s" in message for message in TRANSCRIBE.speaker_quality_warnings(speakers, diagnostics)))

    def test_unicode_punctuation_is_preserved(self):
        words = [{"start": 0, "end": 0.5, "text": "你好，"}, {"start": 0.5, "end": 1, "text": "世界。"}]
        segments, _, _ = TRANSCRIBE.assemble_segments(words, [{"start": 0, "end": 2, "speaker": 4}],
                                                      [TRANSCRIBE.Span("測試", 0, 2, 0)])
        self.assertEqual(segments[0]["text"], "你好，世界。")
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "output.json"
            TRANSCRIBE.atomic_json(target, {"segments": segments})
            self.assertIn("你好，世界。", target.read_text())
            self.assertEqual(json.loads(target.read_text())["segments"], segments)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(Path(temporary).iterdir()), [target])

    def test_network_audit_denies_outbound_operations(self):
        for event in ["socket.connect", "socket.getaddrinfo", "urllib.Request", "http.client.connect"]:
            with self.subTest(event=event), self.assertRaises(TRANSCRIBE.TranscriptError):
                TRANSCRIBE.offline_audit(event, ())
        TRANSCRIBE.offline_audit("open", ())

    def test_missing_models_fail_without_attempting_network(self):
        with tempfile.TemporaryDirectory() as temporary, self.assertRaisesRegex(TRANSCRIBE.TranscriptError, "runtime never downloads"):
            TRANSCRIBE.ensure_models(Path(temporary))

    def test_cli_cannot_replace_source_manifest_or_recording(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source = directory / "synthetic.wav"
            source.write_bytes(b"not-real-audio")
            item = manifest()
            item["recordings"][0]["file"] = str(source)
            input_path = directory / "manifest.json"
            TRANSCRIBE.atomic_json(input_path, item)
            for output in [input_path, source, directory / "models" / "model.bin"]:
                with self.subTest(output=output):
                    result = subprocess.run([sys.executable, str(ROOT / "scripts/transcribe.py"), "--manifest", str(input_path),
                                             "--output", str(output), "--models", str(directory / "models")], capture_output=True, text=True)
                    self.assertEqual(result.returncode, 1)
                    self.assertIn("must not overwrite", result.stderr)
                    self.assertEqual(source.read_bytes(), b"not-real-audio")
                    self.assertEqual(json.loads(input_path.read_text()), item)

    def test_overlapping_source_offsets_remain_sorted(self):
        spans = [TRANSCRIBE.Span("a", 0, 10, 0), TRANSCRIBE.Span("b", 10, 20, 5)]
        words = [{"start": 8, "end": 9, "text": " first"}, {"start": 10, "end": 11, "text": " second"}]
        turns = [{"start": 0, "end": 20, "speaker": 3}]
        segments, _, _ = TRANSCRIBE.assemble_segments(words, turns, spans)
        self.assertEqual([item["start"] for item in segments], [5, 8])


def smoke():
    """Only synthetic speech produced by local macOS voices, never real meetings."""
    python = ROOT / ".meeting-mate/transcript-venv/bin/python"
    models = ROOT / ".meeting-mate/models"
    if not python.is_file():
        raise RuntimeError("Run pnpm run transcript:setup before the synthetic smoke test")
    folder = ROOT / ".meeting-mate/transcript-smoke"
    folder.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix="two-voices-", dir=folder))
    # Reed and Samantha on some macOS installations share a very similar voice
    # embedding; use the independently voiced British Daniel for this fixture.
    voices = ["Samantha", "Daniel", "Samantha", "Daniel"]
    sentences = [
        "Good morning everyone. We need to finish the project proposal before Friday. I will prepare the design document and send it for review.",
        "That sounds good. I will test the new recording feature and check the audio quality. We should review the results tomorrow afternoon.",
        "I have one more update. The customer asked for a local transcript with separate speaker labels. No meeting audio should leave this computer.",
        "I agree with that plan. Please keep the recording private and export a readable transcript after the meeting. I will verify the timestamps.",
    ]
    for index, (voice, sentence) in enumerate(zip(voices, sentences)):
        subprocess.run(["/usr/bin/say", "-v", voice, "-r", "155", "-o", str(directory / f"voice-{index}.aiff"), sentence], check=True, timeout=60)
    recordings = []
    offset = 0
    for index in range(2):
        filename = directory / f"part-{index + 1}.wav"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(directory / f"voice-{index * 2}.aiff"),
                        "-i", str(directory / f"voice-{index * 2 + 1}.aiff"), "-filter_complex",
                        "[0:a]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono,apad=pad_dur=1[a];"
                        "[1:a]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono[b];[a][b]concat=n=2:v=0:a=1[out]",
                        "-map", "[out]", "-c:a", "pcm_s16le", str(filename)], check=True, timeout=60)
        with wave.open(str(filename)) as audio:
            duration = audio.getnframes() / audio.getframerate()
        recordings.append({"id": filename.name, "file": str(filename), "duration": duration,
                           "offsetSeconds": offset, "startedAt": None, "endedAt": None})
        offset += duration + 15  # An explicit pause between files must survive.
    input_path, output_path = directory / "input.json", directory / "output.json"
    TRANSCRIBE.atomic_json(input_path, {"jobId": "synthetic-two-voices", "language": "auto", "numSpeakers": None, "recordings": recordings})
    started = time.monotonic()
    completed = subprocess.run([str(python), str(ROOT / "scripts/transcribe.py"), "--manifest", str(input_path),
                                "--output", str(output_path), "--models", str(models)], capture_output=True, text=True, timeout=1800)
    # Validate that stdout contains only the documented progress protocol.
    events = [json.loads(line) for line in completed.stdout.splitlines()]
    assert all(isinstance(event.get("phase"), str) for event in events), completed.stdout
    assert all(0 <= event.get("progress", 0) <= 100 for event in events), completed.stdout
    if completed.returncode:
        raise RuntimeError(f"Synthetic inference failed: {completed.stderr[-4000:]}")
    verify_smoke(directory, time.monotonic() - started)


def verify_smoke(directory, process_elapsed=None):
    """Recheck an existing synthetic output without duplicating model inference."""
    directory = Path(directory).resolve()
    if not directory.is_relative_to((ROOT / ".meeting-mate/transcript-smoke").resolve()):
        raise RuntimeError("Only this project's synthetic fixture directory may be verified")
    python = ROOT / ".meeting-mate/transcript-venv/bin/python"
    models = ROOT / ".meeting-mate/models"
    output_path = directory / "output.json"
    recordings = json.loads((directory / "input.json").read_text())["recordings"]
    output = json.loads(output_path.read_text())
    assert output["segments"], "No text produced for synthetic speech"
    assert len(output["speakers"]) == 2, "Expected two distinct synthetic voices"
    by_recording = {item["id"]: set() for item in recordings}
    for segment in output["segments"]:
        by_recording[segment["recordingId"]].add(segment["speakerId"])
        source = next(item for item in recordings if item["id"] == segment["recordingId"])
        # Worker outputs millisecond precision; source durations retain samples.
        assert source["offsetSeconds"] - 0.001 <= segment["start"] < segment["end"] <= source["offsetSeconds"] + source["duration"] + 0.001
    assert len(set.intersection(*by_recording.values())) >= 2, "Speaker identities did not remain stable across files"
    assert "recording" in " ".join(item["text"] for item in output["segments"]).lower()
    silence = directory / "silence.wav"
    with wave.open(str(silence), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\0" * 16000 * 2 * 3)
    silent_input, silent_output = directory / "silence-input.json", directory / "silence-output.json"
    TRANSCRIBE.atomic_json(silent_input, {"jobId": "synthetic-silence", "language": "auto", "numSpeakers": None,
        "recordings": [{"id": "silence.wav", "file": str(silence), "duration": 3, "offsetSeconds": 0}]})
    subprocess.run([str(python), str(ROOT / "scripts/transcribe.py"), "--manifest", str(silent_input),
                    "--output", str(silent_output), "--models", str(models)], check=True, timeout=60, stdout=subprocess.DEVNULL)
    empty = json.loads(silent_output.read_text())
    assert empty["speakers"] == [] and empty["segments"] == [], "Silence must not produce invented speech"
    report = {"ok": True, "fixtureDirectory": str(directory), "recordedSeconds": sum(item["duration"] for item in recordings),
              "wallClockSeconds": output["duration"], "elapsedSeconds": output["engine"]["elapsedSeconds"],
              "processElapsedSeconds": round(process_elapsed, 3) if process_elapsed is not None else None,
              "speakers": len(output["speakers"]),
              "segments": len(output["segments"]), "silenceEmpty": True, "language": output["language"],
              "output": str(output_path), "warnings": output["warnings"],
              "limitations": "Synthetic voices only; not a real-meeting accuracy benchmark."}
    TRANSCRIBE.atomic_json(directory / "report.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))


def compare_embeddings(input_path):
    """Bounded diagnostic on an explicitly supplied local manifest; no uploads."""
    import numpy as np
    models = ROOT / ".meeting-mate/models"
    alternative = "nemo_en_titanet_small.onnx"
    if not (models / alternative).is_file():
        raise RuntimeError("Diagnostic requires the official sherpa-onnx nemo_en_titanet_small.onnx model")
    item = TRANSCRIBE.validate_manifest(json.loads(Path(input_path).read_text()))
    if sum(recording["duration"] for recording in item["recordings"]) > 120:
        raise RuntimeError("Embedding comparison is limited to 120 seconds of explicitly authorized audio")
    folder = ROOT / ".meeting-mate/transcript-smoke"
    folder.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix="embedding-comparison-", dir=folder))
    started = time.monotonic()
    original_embedding, original_progress = TRANSCRIBE.EMBEDDING, TRANSCRIBE.progress
    report = {"sourceJobId": item["jobId"], "clusteringThreshold": 0.5, "cases": [],
              "limitations": "Unlabeled audio: cluster counts/distribution are diagnostic, not diarization accuracy."}
    TRANSCRIBE.progress = lambda *args: None
    sys.addaudithook(TRANSCRIBE.offline_audit)
    try:
        with tempfile.TemporaryDirectory(prefix="audio-", dir=directory) as temporary:
            pcm = Path(temporary) / "session.f32"
            spans = TRANSCRIBE.extract_audio(item["recordings"], pcm, [])
            audio = np.memmap(pcm, dtype="<f4", mode="r")
            try:
                report["audio"] = {"seconds": len(audio) / 16000, "sampleRate": 16000,
                                   "peak": float(np.max(np.abs(audio))), "rms": float(np.sqrt(np.mean(audio ** 2)))}
                words = None
                for embedding, count in [(original_embedding, None), (alternative, None), (original_embedding, 2), (alternative, 2)]:
                    if time.monotonic() - started > 150:
                        report["stoppedEarly"] = "150 second diagnostic time budget"
                        break
                    TRANSCRIBE.EMBEDDING = embedding
                    case_started = time.monotonic()
                    turns = TRANSCRIBE.diarize(audio, models, count)
                    if words is None:
                        words, report["language"] = TRANSCRIBE.recognize(audio, models, item["language"], turns)
                    diagnostics = {}
                    segments, speakers, dropped = TRANSCRIBE.assemble_segments(words, turns, spans, diagnostics)
                    case = {"embedding": embedding, "numSpeakers": count, "estimatedSpeakers": len(speakers),
                            "segments": len(segments), "alignedWordSeconds": diagnostics["speakerSupportSeconds"],
                            "characters": {speaker["id"]: sum(len(segment["text"]) for segment in segments if segment["speakerId"] == speaker["id"]) for speaker in speakers},
                            "unknownWords": diagnostics["unknownWords"], "droppedWords": dropped,
                            "elapsedSeconds": round(time.monotonic() - case_started, 3), "turns": turns,
                            "warnings": TRANSCRIBE.speaker_quality_warnings(speakers, diagnostics)}
                    report["cases"].append(case)
                    TRANSCRIBE.atomic_json(directory / "report.json", report)
                    print(json.dumps({key: value for key, value in case.items() if key not in {"turns", "warnings"}}), flush=True)
            finally:
                audio._mmap.close()
    finally:
        TRANSCRIBE.EMBEDDING, TRANSCRIBE.progress = original_embedding, original_progress
    report["elapsedSeconds"] = round(time.monotonic() - started, 3)
    TRANSCRIBE.atomic_json(directory / "report.json", report)
    print(json.dumps({"report": str(directory / "report.json"), "elapsedSeconds": report["elapsedSeconds"]}), flush=True)


if __name__ == "__main__":
    if sys.argv[1:] == ["--smoke"]:
        smoke()
    elif len(sys.argv) == 3 and sys.argv[1] == "--verify-smoke":
        verify_smoke(sys.argv[2])
    elif len(sys.argv) == 3 and sys.argv[1] == "--compare-embeddings":
        compare_embeddings(sys.argv[2])
    else:
        unittest.main()
