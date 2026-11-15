#!/usr/bin/env python3
"""Smoke test one media file through the model stages without the API.

    .venv/bin/python scripts/smoke.py /path/to/video.mp4 --device mps

Prints chunk count, per-stage wall time, real-time factor and the first
subtitle lines, so an MPS or CUDA host can be judged on measured numbers
instead of a guess.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from asr_worker import align, audio, transcribe  # noqa: E402
from asr_worker.device import detect_device  # noqa: E402
from asr_worker.subtitles import build_segments, to_srt  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("file", help="video or audio file to process")
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "mps", "cpu"])
    parser.add_argument("--model-dir", default=str(ROOT.parent.parent / "models" / "asr"))
    parser.add_argument("--aligner-dir", default=str(ROOT.parent.parent / "models" / "aligner"))
    parser.add_argument("--language", default="ko")
    parser.add_argument("--keep", action="store_true", help="keep the temporary work directory")
    args = parser.parse_args()

    source = Path(args.file).expanduser().resolve()
    if not source.is_file():
        raise SystemExit(f"file not found: {source}")

    device = detect_device(args.device)
    workdir = Path(tempfile.mkdtemp(prefix="asr-smoke-"))
    print(f"device={device} file={source.name} workdir={workdir}")

    try:
        started = time.monotonic()
        wav = workdir / "audio.wav"
        audio.extract_audio(source, wav)
        duration_ms = audio.probe_duration_ms(wav)
        silences = audio.detect_silences(wav)
        plan = audio.plan_chunks(duration_ms, silences)

        chunks = []
        for index, (start_ms, end_ms) in enumerate(plan):
            path = workdir / f"chunk-{index:04d}.wav"
            audio.slice_wav(wav, start_ms, end_ms, path)
            chunks.append(
                {"index": index, "start_ms": start_ms, "end_ms": end_ms, "wav": str(path)}
            )

        plan_path = workdir / "chunks.json"
        plan_path.write_text(json.dumps({"chunks": chunks}), encoding="utf-8")
        print(f"duration={duration_ms / 1000:.1f}s chunks={len(chunks)}")

        asr_started = time.monotonic()
        asr_path = workdir / "asr.json"
        transcribe.run(plan_path, args.model_dir, device, args.language, asr_path)
        asr_seconds = time.monotonic() - asr_started

        align_started = time.monotonic()
        aligned_path = workdir / "aligned.json"
        align.run(asr_path, args.aligner_dir, device, args.language, aligned_path)
        align_seconds = time.monotonic() - align_started

        aligned = json.loads(aligned_path.read_text(encoding="utf-8"))
        segments = build_segments(aligned["chunks"])
        total_seconds = time.monotonic() - started
        media_seconds = duration_ms / 1000

        print(f"asr={asr_seconds:.1f}s align={align_seconds:.1f}s total={total_seconds:.1f}s")
        print(f"rtf={total_seconds / media_seconds:.2f} (lower is faster than real time)")
        print(f"segments={len(segments)}")
        print(to_srt(segments[:5]))

        failed = [chunk for chunk in aligned["chunks"] if chunk.get("status") == "align_failed"]
        if failed:
            print(f"align_failed_chunks={len(failed)} first={failed[0].get('align_error')}")
        return 0
    finally:
        if args.keep:
            print(f"kept {workdir}")
        else:
            shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
