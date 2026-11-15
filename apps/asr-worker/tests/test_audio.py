from __future__ import annotations

import math
import struct
import wave
from pathlib import Path

from asr_worker.audio import detect_silences, plan_chunks

RATE = 16_000
TONE_HZ = 440.0
TONE_AMPLITUDE = 0.4


def write_wav(path: Path, samples: list[int]) -> Path:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    return path


def silence(ms: int) -> list[int]:
    return [0] * (RATE * ms // 1000)


def tone(ms: int) -> list[int]:
    peak = int(TONE_AMPLITUDE * 32767)
    return [
        int(peak * math.sin(2 * math.pi * TONE_HZ * index / RATE))
        for index in range(RATE * ms // 1000)
    ]


def test_silent_clip_is_detected(tmp_path: Path) -> None:
    clip = write_wav(tmp_path / "silent.wav", silence(2000))

    intervals = detect_silences(clip)

    assert any(start <= 50 and end >= 1950 for start, end in intervals), intervals


def test_cut_lands_on_a_silence_midpoint(tmp_path: Path) -> None:
    clip = write_wav(
        tmp_path / "mixed.wav",
        silence(1500) + tone(900) + silence(1000) + tone(3100),
    )

    silences = detect_silences(clip)

    assert len(silences) == 2, silences
    first, second = silences
    assert first[0] <= 50 and 1450 <= first[1] <= 1550, first
    assert 2350 <= second[0] <= 2450 and 3350 <= second[1] <= 3450, second

    chunks = plan_chunks(6500, silences, min_ms=1500, max_ms=3000)

    assert chunks[0] == (0, 2900)
