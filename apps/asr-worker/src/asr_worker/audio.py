from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

SAMPLE_RATE = 16_000

_SILENCE_START = re.compile(r"silence_start:\s*(-?\d+(?:\.\d+)?)")
_SILENCE_END = re.compile(r"silence_end:\s*(-?\d+(?:\.\d+)?)")


def run_ffmpeg(args: list[str], timeout: int = 3600) -> str:
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        detail = (result.stderr or "").strip().splitlines()
        tail = " | ".join(detail[-3:]) if detail else f"exit {result.returncode}"
        raise RuntimeError(f"ffmpeg failed: {tail}")
    return result.stderr or ""


def resolve_media(media_root: str, relative: str) -> Path:
    """Only files under the read-only media root may be opened."""
    root = Path(media_root).resolve()
    candidate = Path(relative)
    if candidate.is_absolute():
        raise ValueError(f"media path must be relative: {relative}")
    target = (root / candidate).resolve()
    if target != root and root not in target.parents:
        raise ValueError(f"media path escapes the media root: {relative}")
    if not target.is_file():
        raise FileNotFoundError(f"media file is missing: {target}")
    return target


def probe_duration_ms(path: Path) -> int:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed for {path.name}")
    payload = json.loads(result.stdout or "{}")
    duration = payload.get("format", {}).get("duration")
    if duration is None:
        raise RuntimeError(f"ffprobe reported no duration for {path.name}")
    return int(round(float(duration) * 1000))


def has_audio_stream(path: Path) -> bool:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
            str(path),
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    return result.returncode == 0 and bool(result.stdout.strip())


def extract_audio(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(
        [
            "-y",
            "-i",
            str(source),
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-c:a",
            "pcm_s16le",
            str(target),
        ]
    )


def detect_silences(wav: Path, noise_db: int = -35, min_silence_s: float = 0.35) -> list[tuple[int, int]]:
    stderr = run_ffmpeg(
        [
            "-i",
            str(wav),
            "-af",
            f"silencedetect=noise={noise_db}dB:d={min_silence_s}",
            "-f",
            "null",
            "-",
        ]
    )
    silences: list[tuple[int, int]] = []
    open_start: int | None = None
    for line in stderr.splitlines():
        start = _SILENCE_START.search(line)
        if start:
            open_start = int(float(start.group(1)) * 1000)
            continue
        end = _SILENCE_END.search(line)
        if end and open_start is not None:
            silences.append((open_start, int(float(end.group(1)) * 1000)))
            open_start = None
    return silences


def plan_chunks(
    duration_ms: int,
    silences: list[tuple[int, int]],
    min_ms: int = 15_000,
    max_ms: int = 30_000,
) -> list[tuple[int, int]]:
    """
    Split on silence midpoints so a word is not cut in half, and fall back to a
    hard cut at max_ms when a passage has no pause. Chunks are contiguous.
    """
    if duration_ms <= max_ms:
        return [(0, duration_ms)]

    midpoints = sorted((start + end) // 2 for start, end in silences)
    chunks: list[tuple[int, int]] = []
    start = 0
    while duration_ms - start > max_ms:
        low = start + min_ms
        high = start + max_ms
        candidates = [point for point in midpoints if low <= point <= high]
        cut = candidates[-1] if candidates else high
        chunks.append((start, cut))
        start = cut

    if duration_ms - start > 0:
        chunks.append((start, duration_ms))

    if len(chunks) >= 2 and chunks[-1][1] - chunks[-1][0] < 3_000:
        previous = chunks[-2]
        chunks[-2] = (previous[0], chunks[-1][1])
        chunks.pop()

    return chunks


def slice_wav(wav: Path, start_ms: int, end_ms: int, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(
        [
            "-y",
            "-ss",
            f"{start_ms / 1000:.3f}",
            "-t",
            f"{(end_ms - start_ms) / 1000:.3f}",
            "-i",
            str(wav),
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-c:a",
            "pcm_s16le",
            str(target),
        ]
    )
