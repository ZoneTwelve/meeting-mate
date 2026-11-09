---
name: transcript-convert
description: Convert local audio or video into complete timestamped transcripts with acoustic speaker labels using Meeting Mate's offline CPU or Apple MPS worker.
metadata:
  short-description: Convert recordings into speaker-labelled transcripts
---

# Transcript conversion

Produce a readable UTF-8 TXT transcript and the canonical JSON result. Resolve the
checkout containing `scripts/transcribe.py`; all paths below are relative to it.
Read [the worker interface](../../docs/transcript.md) for setup, manifest fields,
backend options and output warnings.

## Choose the engine

- Honor the requested model and device. Do not silently substitute small when the
  user requests large-v3-turbo.
- CPU: `.meeting-mate/transcript-venv/bin/python`, `--backend cpu --model small`.
- MPS: `.meeting-mate/transcript-mps-venv/bin/python`, `--backend mps --model small`
  or `--backend mps --model large-v3-turbo`.
- MPS runs Whisper on the Apple GPU; speaker diarization and final DTW alignment
  still use CPU. GPU availability is not evidence of a speed improvement. Use the
  measured `engine.asrSeconds`, `diarizationSeconds` and `elapsedSeconds` when
  comparing runs; distinguish model changes and first-run overhead.
- If the user has no model preference, use the repository configuration, or the
  CPU/small default. If dependencies are missing, use the documented setup for
  that backend. Keep inference local; do not upload meeting audio.

## Convert and verify

1. Resolve the exact source path and inspect it with `ffprobe`. Keep the original
   recording intact. If it is still growing, a copy is only a partial snapshot;
   do not call it a complete meeting transcript.
2. Create the manifest under ignored private runtime state, with the decoded
   duration, absolute recording path, `language: "auto"` unless specified, and
   `numSpeakers: null` unless the user supplies a count. Preserve source offsets
   for multiple recordings. Do not treat an estimated count as a known fact.
3. Run `scripts/transcribe.py --manifest <input> --output <result> --models
   <checkout>/.meeting-mate/models` with the chosen Python and backend/model flags.
   Report phase progress for long jobs. A queued process or exit 0 alone is not
   proof that speech was transcribed correctly.
4. Inspect the result: source coverage and duration, nonempty speech, chronological
   timestamps, requested model/device, speaker labels and warnings. Check actual
   text for repetition or missing speech. An implausibly large number of speakers
   is a quality problem to disclose, not evidence of that many participants.
5. Format the checked result with this skill's helper:

   ```sh
   python3 skills/transcript-convert/scripts/format_transcript.py <result.json> <transcript.txt>
   ```

   The helper preserves Unknown speaker and warnings, and refuses to replace an
   existing destination. Use a fresh output name for model comparisons.

Keep complete speech unless the user asks to trim it. Speaker N labels represent
acoustic clusters, not verified people; do not invent names or a speaker count.
Preserve unknown words, overlap warnings and low-support labels instead of
silently merging or discarding them. Whisper alone cannot provide speaker labels.

Place outputs at the user's destination, or under ignored `transcripts/` using
names such as `transcript-YYYY-MM-DD-HH-MM.txt` and the corresponding `.json`.
Link both outputs and report duration, model/device and material quality warnings.
Recordings, weights, manifests and transcript artifacts do not belong in Git.
