#!/usr/bin/env python3
"""
Sample preparation script for Vent Fan Beat Simulator.

Dependencies:
    pip install pydub

    pydub requires ffmpeg to read mp3/advanced formats.
    Install ffmpeg (e.g. macOS: `brew install ffmpeg`, Windows: download binaries).
"""

import json
import math
import pathlib

from pydub import AudioSegment

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "samples_raw"
OUT_DIR = ROOT / "samples"

TARGET_DBFS = -6.0
SILENCE_THRESH_DBFS = -40.0
MIN_SILENCE_MS = 50


def detect_leading_silence(seg: AudioSegment) -> int:
    """Return the number of ms to trim from the start."""
    trim_ms = 0
    thresh_linear = seg.max_possible_amplitude * (10 ** (SILENCE_THRESH_DBFS / 20))
    chunk = max(1, MIN_SILENCE_MS // 5)

    while trim_ms < len(seg):
        chunk_slice = seg[trim_ms : trim_ms + chunk]
        if chunk_slice.max > thresh_linear:
            break
        trim_ms += chunk
    return trim_ms


def process_file(src: pathlib.Path, dst: pathlib.Path):
    audio = AudioSegment.from_file(src)
    audio = audio.set_channels(1).set_frame_rate(44100)

    change_db = TARGET_DBFS - audio.dBFS if not math.isinf(audio.dBFS) else 0
    normalized = audio.apply_gain(change_db)
    start_trim = detect_leading_silence(normalized)
    if start_trim > 0:
        normalized = normalized[start_trim:]

    dst.parent.mkdir(parents=True, exist_ok=True)
    normalized.export(dst, format="wav")

    print(
        f"[OK] {src.name} | orig {audio.dBFS:.1f} dBFS | "
        f"gain {change_db:+.1f} dB | trimmed {start_trim} ms | -> {dst.relative_to(ROOT)}"
    )

    return {"file": dst.name, "label": src.stem}


def ensure_dirs() -> bool:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if not RAW_DIR.exists():
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        print(
            f"[prepare_samples] Created {RAW_DIR.relative_to(ROOT)}. "
            "Add .mp3/.wav files there and re-run."
        )
        return False
    return True


def main() -> None:
    if not ensure_dirs():
        return

    sources = [
        entry
        for entry in sorted(RAW_DIR.iterdir())
        if entry.is_file() and entry.suffix.lower() in {".mp3", ".wav"}
    ]

    if not sources:
        print(
            f"[prepare_samples] No .mp3/.wav files found in "
            f"{RAW_DIR.relative_to(ROOT)}/. Nothing to do."
        )
        return

    processed = 0
    manifest_entries = []
    for entry in sources:
        if not entry.is_file():
            continue
        if entry.suffix.lower() not in {".mp3", ".wav"}:
            continue
        out_name = entry.stem + ".wav"
        out_path = OUT_DIR / out_name
        meta = process_file(entry, out_path)
        if meta:
            manifest_entries.append(meta)
            processed += 1

    if processed == 0:
        print("No .mp3 or .wav files found in samples_raw/.")
    else:
        manifest_path = OUT_DIR / "manifest.json"
        with manifest_path.open("w", encoding="utf-8") as f:
            json.dump(manifest_entries, f, ensure_ascii=False, indent=2)
        print(f"Processed {processed} file(s).")
        print(
            f"[prepare_samples] Wrote manifest with {len(manifest_entries)} entries to {manifest_path.relative_to(ROOT)}"
        )


if __name__ == "__main__":
    main()
