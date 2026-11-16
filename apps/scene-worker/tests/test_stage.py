from __future__ import annotations

import subprocess
from pathlib import Path

from scene_worker import stage


def test_the_flag_reads_the_thumbnail_from_the_clip(monkeypatch, tmp_path: Path) -> None:
    calls: list[tuple[str, int, Path]] = []
    monkeypatch.setattr(
        stage,
        "write_thumbnail",
        lambda source, at_ms, dest: calls.append((source, at_ms, dest)),
    )
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"clip")
    dest = tmp_path / "thumb.jpg"

    stage.write_window_thumbnail("/media/a.mp4", clip, 10_000, 20_000, dest, from_clip=True)

    assert calls == [(str(clip), 5_000, dest)]


def test_the_flag_off_keeps_the_original_source_path(monkeypatch, tmp_path: Path) -> None:
    calls: list[tuple[str, int, Path]] = []
    monkeypatch.setattr(
        stage,
        "write_thumbnail",
        lambda source, at_ms, dest: calls.append((source, at_ms, dest)),
    )
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"clip")
    dest = tmp_path / "thumb.jpg"

    stage.write_window_thumbnail("/media/a.mp4", clip, 10_000, 20_000, dest, from_clip=False)

    assert calls == [("/media/a.mp4", 15_000, dest)]


def test_the_clip_exists_when_the_thumbnail_is_written(monkeypatch, tmp_path: Path) -> None:
    seen: list[bool] = []

    def fake(source: str, at_ms: int, dest: Path) -> None:
        seen.append(Path(source).is_file())

    monkeypatch.setattr(stage, "write_thumbnail", fake)
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"clip")

    stage.write_window_thumbnail(
        "/media/a.mp4", clip, 0, 10_000, tmp_path / "thumb.jpg", from_clip=True
    )

    assert seen == [True]


def test_thumbnail_is_a_320_wide_jpeg(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=640x360:rate=1:duration=1",
            "-pix_fmt",
            "yuv420p",
            str(source),
        ],
        check=True,
        capture_output=True,
    )
    dest = tmp_path / "thumb.jpg"

    stage.write_thumbnail(str(source), 0, dest)

    assert dest.read_bytes()[:2] == b"\xff\xd8"
    width = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width",
            "-of",
            "csv=p=0",
            str(dest),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert width.stdout.strip() == "320"
