from __future__ import annotations

import math
import os
import stat
import struct
import wave
from pathlib import Path

from asr_worker.audio import _slice_wav_ffmpeg, detect_silences, plan_chunks, slice_wav

RATE = 16_000
TONE_HZ = 440.0
TONE_AMPLITUDE = 0.4


def write_wav(path: Path, samples: list[int], channels: int = 1, rate: int = RATE) -> Path:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    return path


def read_wav(path: Path) -> tuple[int, int, int, bytes]:
    with wave.open(str(path), "rb") as handle:
        return (
            handle.getnchannels(),
            handle.getsampwidth(),
            handle.getframerate(),
            handle.readframes(handle.getnframes()),
        )


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


def test_detect_silences_reads_a_log_written_in_a_legacy_codepage(tmp_path, monkeypatch):
    fake = tmp_path / "ffmpeg"
    fake.write_text(
        "#!/bin/sh\n"
        "printf 'copyright : www.example.la \\263\\326\\320\\370\\n' >&2\n"
        "printf '[silencedetect @ 0x1] silence_start: 1.5\\n' >&2\n"
        "printf '[silencedetect @ 0x1] silence_end: 2.5 | silence_duration: 1\\n' >&2\n"
        "exit 0\n",
        encoding="utf-8",
    )
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")

    assert detect_silences(Path("audio.wav")) == [(1500, 2500)]


def test_slices_a_ramp_at_exact_frame_boundaries(tmp_path: Path) -> None:
    samples = [index * 2 - 16_000 for index in range(RATE)]
    source = write_wav(tmp_path / "ramp.wav", samples)
    first = tmp_path / "first.wav"
    second = tmp_path / "second.wav"

    slice_wav(source, 0, 500, first)
    slice_wav(source, 500, 1_000, second)

    _, _, _, first_bytes = read_wav(first)
    _, _, _, second_bytes = read_wav(second)
    assert list(struct.unpack(f"<{RATE // 2}h", first_bytes)) == samples[: RATE // 2]
    assert list(struct.unpack(f"<{RATE // 2}h", second_bytes)) == samples[RATE // 2 :]


def test_matches_ffmpeg_within_one_frame(tmp_path: Path) -> None:
    source = write_wav(tmp_path / "tone.wav", tone(2_000))
    boundaries = [(0, 123), (123, 456), (456, 1_000), (1_000, 1_777), (1_777, 2_000)]

    for index, (start_ms, end_ms) in enumerate(boundaries):
        fast = tmp_path / f"fast-{index}.wav"
        slow = tmp_path / f"slow-{index}.wav"
        slice_wav(source, start_ms, end_ms, fast)
        _slice_wav_ffmpeg(source, start_ms, end_ms, slow)

        fast_bytes = read_wav(fast)[3]
        slow_bytes = read_wav(slow)[3]
        fast_frames = len(fast_bytes) // 2
        slow_frames = len(slow_bytes) // 2
        assert abs(fast_frames - slow_frames) <= 1, (start_ms, end_ms, fast_frames, slow_frames)

        common = min(len(fast_bytes), len(slow_bytes))
        assert fast_bytes[:common] == slow_bytes[:common], (start_ms, end_ms)


def test_falls_back_for_a_stereo_source(tmp_path: Path) -> None:
    mono = tone(1_000)
    stereo = [sample for value in mono for sample in (value, value)]
    source = write_wav(tmp_path / "stereo.wav", stereo, channels=2, rate=44_100)
    target = tmp_path / "chunk.wav"

    slice_wav(source, 0, 500, target)

    channels, width, rate, frames = read_wav(target)
    assert (channels, width, rate) == (1, 2, RATE)
    assert len(frames) > 0


def test_a_zero_length_chunk_writes_a_valid_empty_wav(tmp_path: Path) -> None:
    source = write_wav(tmp_path / "source.wav", tone(1_000))
    target = tmp_path / "empty.wav"

    slice_wav(source, 500, 500, target)

    channels, width, rate, frames = read_wav(target)
    assert (channels, width, rate) == (1, 2, RATE)
    assert frames == b""
