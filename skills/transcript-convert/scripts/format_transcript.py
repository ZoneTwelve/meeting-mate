#!/usr/bin/env python3
"""Format a Meeting Mate result without losing speaker labels or warnings."""

import argparse
import json
import math
import os
from pathlib import Path


def timestamp(value):
    value = float(value)
    if not math.isfinite(value) or value < 0:
        raise ValueError("Timestamps must be finite and nonnegative")
    milliseconds = round(value * 1000)
    seconds, milliseconds = divmod(milliseconds, 1000)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{milliseconds:03d}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = json.loads(args.input.read_text(encoding="utf-8"))
    labels = {item["id"]: item["label"] for item in result["speakers"]}
    lines = [f"Duration: {timestamp(result['duration'])}",
             "Speaker labels are acoustic estimates, not verified identities.", ""]
    for segment in result["segments"]:
        speaker = labels.get(segment.get("speakerId"), "Unknown speaker")
        lines.append(f"[{timestamp(segment['start'])}–{timestamp(segment['end'])}] "
                     f"{speaker}: {segment['text'].strip()}")
    if result.get("warnings"):
        lines.extend(["", "Warnings:", *result["warnings"]])
    data = "\n".join(lines) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation also refuses a destination symlink or the input itself.
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        output.write(data)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
