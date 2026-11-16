from __future__ import annotations

import struct
import subprocess
import sys
import wave
from pathlib import Path

import pytest

from asr_worker import probe
from asr_worker.probe import pick_samples, read_pcm16


def write_wave(path: Path, samples: list[int], rate: int = 16_000, channels: int = 1) -> None:
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(channels)
        stream.setsampwidth(2)
        stream.setframerate(rate)
        stream.writeframes(struct.pack(f"<{len(samples)}h", *samples))


def test_samples_spread_evenly_over_the_plan() -> None:
    chunks = [{"index": index} for index in range(10)]

    assert pick_samples(chunks, 5) == [0, 2, 4, 6, 9]


def test_samples_never_repeat_and_cover_a_short_plan() -> None:
    chunks = [{"index": index} for index in range(3)]

    assert pick_samples(chunks, 3) == [0, 1, 2]
    assert pick_samples(chunks, 5) == [0, 1, 2]
    assert pick_samples(chunks, 1) == [0]
    assert pick_samples(chunks, 0) == []
    assert pick_samples([], 5) == []


def test_pcm16_becomes_float_samples(tmp_path) -> None:
    path = tmp_path / "clip.wav"
    write_wave(path, [0, 32767, -32768, 16384])

    assert list(read_pcm16(path)) == pytest.approx([0.0, 0.99997, -1.0, 0.5], abs=1e-5)


def test_only_the_requested_window_is_read(tmp_path) -> None:
    path = tmp_path / "clip.wav"
    write_wave(path, [0] * 32_000)

    assert len(read_pcm16(path, limit_ms=500)) == 8_000


def test_importing_the_probe_does_not_load_torch() -> None:
    source = Path(probe.__file__).resolve().parents[1]
    script = (
        f"import sys; sys.path.insert(0, {str(source)!r}); "
        "import asr_worker.probe; print('torch' in sys.modules)"
    )

    result = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, check=True
    )

    assert result.stdout.strip() == "False"
