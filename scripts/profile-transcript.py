#!/usr/bin/env python3
"""Offline, bounded ASR profiling. Writes private reports, never transcript text."""

import argparse
import cProfile
from contextlib import contextmanager, nullcontext
from functools import wraps
import hashlib
import importlib
import json
from pathlib import Path
import pstats
import statistics
import sys
import tempfile
import time

import transcribe as worker


class Stages:
    """Synchronized wall times, including host work; these are not GPU kernel times."""

    def __init__(self, synchronize=lambda: None):
        self.synchronize = synchronize
        self.stack = []
        self.results = {}

    @contextmanager
    def patch(self, owner, attribute, label):
        original = getattr(owner, attribute)

        @wraps(original)
        def measured(*args, **kwargs):
            name = label
            if label in {"encoder", "decoder"} and any(frame["name"] == "alignment" for frame in self.stack):
                name = "alignment." + label
            self.synchronize()
            frame = {"name": name, "children": 0.0}
            self.stack.append(frame)
            started = time.perf_counter()
            try:
                return original(*args, **kwargs)
            finally:
                self.synchronize()
                elapsed = time.perf_counter() - started
                self.stack.pop()
                if self.stack:
                    self.stack[-1]["children"] += elapsed
                result = self.results.setdefault(name, {"calls": 0, "inclusiveSeconds": 0.0, "exclusiveSeconds": 0.0})
                result["calls"] += 1
                result["inclusiveSeconds"] += elapsed
                result["exclusiveSeconds"] += max(0, elapsed - frame["children"])

        setattr(owner, attribute, measured)
        try:
            yield
        finally:
            setattr(owner, attribute, original)


def signature(words):
    encoded = json.dumps(words, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    text = "".join(word["text"] for word in words)
    return {"words": len(words), "characters": len(text), "wordTimestampSha256": hashlib.sha256(encoded).hexdigest(),
            "textSha256": hashlib.sha256(text.encode()).hexdigest()}


def profile_rows(profile):
    rows = []
    for (filename, line, function), (primitive, calls, own, cumulative, callers) in pstats.Stats(profile).stats.items():
        # Raw pstats remain private; summary names contain no absolute paths.
        rows.append({"function": f"{Path(filename).name}:{line}:{function}", "calls": calls,
                     "selfSeconds": round(own, 6), "cumulativeSeconds": round(cumulative, 6)})
    return sorted(rows, key=lambda row: row["selfSeconds"], reverse=True)


def mps_runner(models, model, audio, language, report):
    before = time.perf_counter()
    torch, whisper = worker.require_mps()
    report["importSeconds"] = time.perf_counter() - before
    before = time.perf_counter()
    engine = worker.load_mps_model(models, model)
    report["loadSeconds"] = time.perf_counter() - before
    report["versions"] = {"torch": torch.__version__, "whisper": whisper.__version__}
    report["profilerActivities"] = sorted(str(activity) for activity in torch.profiler.supported_activities())
    report["device"] = str(next(engine.parameters()).device)

    def run(word_timestamps=True):
        with torch.inference_mode(), worker.mps_compatibility(use_sdpa=model == "small"):
            result = engine.transcribe(audio.copy(), language=language, task="transcribe", beam_size=5,
                                       word_timestamps=word_timestamps, condition_on_previous_text=False,
                                       hallucination_silence_threshold=2 if word_timestamps else None,
                                       temperature=0.0, fp16=True, verbose=None)
        torch.mps.synchronize()
        words = [{"start": word["start"], "end": word["end"], "text": word["word"]}
                 for segment in result["segments"] for word in segment.get("words", []) if word["end"] > word["start"]]
        return words, {"segments": len(result["segments"]), "language": result["language"],
                       "textSha256": hashlib.sha256(result["text"].encode()).hexdigest()}

    @contextmanager
    def instrument(stages):
        from contextlib import ExitStack
        module = importlib.import_module("whisper.transcribe")
        from whisper import decoding, timing
        with worker.mps_compatibility(use_sdpa=model == "small"), ExitStack() as stack:
            for owner, attribute, label in [
                (module, "log_mel_spectrogram", "mel"),
                (engine.encoder, "forward", "encoder"), (engine.decoder, "forward", "decoder"),
                (decoding.DecodingTask, "_main_loop", "decode"),
                (decoding.BeamSearchDecoder, "update", "beam_search"),
                (decoding.PyTorchInference, "rearrange_kv_cache", "kv_reorder"),
                (decoding.ApplyTimestampRules, "apply", "timestamp_rules"),
                (timing, "find_alignment", "alignment"), (timing, "median_filter", "median_filter"),
                (timing, "dtw_cpu", "dtw_cpu"),
            ]:
                stack.enter_context(stages.patch(owner, attribute, label))
            yield

    return run, instrument, torch.mps.synchronize, engine


def cpu_runner(models, model, audio, language, report):
    before = time.perf_counter()
    from faster_whisper import WhisperModel
    import importlib.metadata
    report["importSeconds"] = time.perf_counter() - before
    before = time.perf_counter()
    engine = WhisperModel(str(models / "faster-whisper-small"), device="cpu", compute_type="int8",
                          cpu_threads=worker.THREADS, num_workers=1, local_files_only=True)
    report["loadSeconds"] = time.perf_counter() - before
    report["versions"] = {name: importlib.metadata.version(name) for name in ("faster-whisper", "ctranslate2")}
    report["device"] = "cpu"

    def run(word_timestamps=True):
        segments, info = engine.transcribe(audio, language=language, task="transcribe", beam_size=5,
                                          word_timestamps=word_timestamps, vad_filter=True,
                                          vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 200},
                                          condition_on_previous_text=False, hallucination_silence_threshold=2,
                                          temperature=0.0, log_progress=False)
        segments = list(segments)
        words = [{"start": word.start, "end": word.end, "text": word.word}
                 for segment in segments for word in segment.words or [] if word.end > word.start]
        return words, {"segments": len(segments), "language": info.language,
                       "audioAfterVadSeconds": info.duration_after_vad,
                       "textSha256": hashlib.sha256("".join(s.text for s in segments).encode()).hexdigest()}

    @contextmanager
    def instrument(stages):
        from contextlib import ExitStack
        with ExitStack() as stack:
            for attribute, label in [("encode", "encoder"), ("generate_with_fallback", "decode"),
                                     ("find_alignment", "alignment")]:
                stack.enter_context(stages.patch(engine, attribute, label))
            yield

    return run, instrument, lambda: None, engine


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--backend", choices=("cpu", "mps"), required=True)
    parser.add_argument("--model", choices=("small", "large-v3-turbo"), default="small")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--trace", action="store_true", help="Export host-side PyTorch trace; not GPU kernel timing")
    parser.add_argument("--mps-decoding", choices=("upstream", "bulk"), default="upstream")
    args = parser.parse_args()
    if not 2 <= args.repeats <= 5:
        parser.error("--repeats must be from 2 to 5 (first run plus warm repeats)")
    if args.manifest.stat().st_size > worker.MAX_MANIFEST_BYTES:
        parser.error("Manifest too large")
    manifest = worker.validate_manifest(json.loads(args.manifest.read_text()))
    if sum(recording["duration"] for recording in manifest["recordings"]) > 120:
        parser.error("Profiling is limited to 120 seconds; use an explicit local excerpt")
    if args.backend == "cpu" and (args.model != "small" or args.trace or args.mps_decoding != "upstream"):
        parser.error("CPU profiling supports small only, without MPS options")
    run_profile(args, manifest)


def run_profile(args, manifest):
    sys.addaudithook(worker.offline_audit)
    args.output_dir.mkdir(parents=True, mode=0o700, exist_ok=False)
    report = {"backend": args.backend, "model": args.model, "threads": worker.THREADS,
              "mpsDecoding": args.mps_decoding if args.backend == "mps" else None,
              "limitations": ["Single local sample; not an accuracy benchmark.",
                              "Stage timings synchronize MPS and perturb execution; compare speed using uninstrumented runs.",
                              "cProfile and PyTorch CPU events measure host activity/waits, not GPU kernel duration or utilization."]}
    before = time.perf_counter()
    worker.ensure_models(args.models, args.backend, args.model)
    report["modelValidationSeconds"] = time.perf_counter() - before
    import numpy as np
    with tempfile.TemporaryDirectory(prefix="audio-", dir=args.output_dir) as temporary:
        pcm = Path(temporary) / "audio.f32"
        before = time.perf_counter()
        worker.extract_audio(manifest["recordings"], pcm, [])
        audio = np.fromfile(pcm, dtype="<f4")
        report["extractSeconds"] = time.perf_counter() - before
    if len(audio) > 120 * worker.RATE:
        raise worker.TranscriptError("Decoded profiling audio exceeds 120 seconds")
    report["audioSeconds"] = len(audio) / worker.RATE
    before = time.perf_counter()
    turns = worker.diarize(audio, args.models, manifest["numSpeakers"])
    report["diarizationSeconds"] = time.perf_counter() - before
    report["speakerClusters"] = len({turn["speaker"] for turn in turns})
    language = None if manifest["language"] == "auto" else manifest["language"]
    factory = mps_runner if args.backend == "mps" else cpu_runner
    run, instrument, synchronize, engine = factory(args.models, args.model, audio, language, report)
    context = nullcontext()
    if args.mps_decoding == "bulk":
        from whisper_mps_decode import optimized_decoding
        context = optimized_decoding()
    with context:
        profile_runs(args, report, run, instrument, synchronize)


def profile_runs(args, report, run, instrument, synchronize):
    report["runs"] = []
    for index in range(args.repeats):
        synchronize()
        before = time.perf_counter()
        words, info = run()
        elapsed = time.perf_counter() - before
        report["runs"].append({"kind": "first" if index == 0 else "warm", "seconds": elapsed,
                               **signature(words), "info": info})
        worker.atomic_json(args.output_dir / "report.json", report)
        print(json.dumps({"run": index, "seconds": round(elapsed, 3), "words": len(words)}), flush=True)
    report["warmMedianSeconds"] = statistics.median(item["seconds"] for item in report["runs"][1:])
    profile = cProfile.Profile()
    synchronize()
    before = time.perf_counter()
    profile.enable()
    words, info = run()
    profile.disable()
    report["cProfileSeconds"] = time.perf_counter() - before
    report["cProfileSignature"] = signature(words)
    profile.dump_stats(str(args.output_dir / "host.pstats"))
    rows = profile_rows(profile)
    report["topHostFunctions"] = rows[:35]
    report["hostScalarReads"] = [row for row in rows if any(name in row["function"] for name in ("'item'", "'tolist'", "'cpu'", "'__bool__'"))]
    worker.atomic_json(args.output_dir / "report.json", report)
    stages = Stages(synchronize)
    before = time.perf_counter()
    with instrument(stages):
        words, info = run()
    report["synchronizedProfileSeconds"] = time.perf_counter() - before
    report["stages"] = stages.results
    report["synchronizedSignature"] = signature(words)
    worker.atomic_json(args.output_dir / "report.json", report)
    if args.trace and args.backend == "mps":
        import torch
        # Shapes only, no tensor values or speech text. Private directory anyway.
        with torch.profiler.profile(activities=[torch.profiler.ProfilerActivity.CPU], record_shapes=True) as trace:
            run()
        trace.export_chrome_trace(str(args.output_dir / "host-trace.json"))
        report["torchCpuEvents"] = [{"operator": event.key, "calls": event.count,
                                     "selfCpuMilliseconds": event.self_cpu_time_total / 1000}
                                    for event in sorted(trace.key_averages(), key=lambda event: event.self_cpu_time_total, reverse=True)[:30]]
    worker.atomic_json(args.output_dir / "report.json", report)
    print(json.dumps({"report": str(args.output_dir / "report.json"), "warmMedianSeconds": report["warmMedianSeconds"],
                      "stages": report["stages"]}), flush=True)


if __name__ == "__main__":
    main()
