from __future__ import annotations

from pathlib import Path

import pytest

from asr_worker.audio import resolve_media


def test_relative_path_inside_the_root_resolves(tmp_path: Path) -> None:
    root = tmp_path / "media"
    (root / "Videos").mkdir(parents=True)
    target = root / "Videos" / "clip.mp4"
    target.write_bytes(b"x")

    assert resolve_media(str(root), "Videos/clip.mp4") == target.resolve()


def test_absolute_paths_are_refused(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        resolve_media(str(tmp_path), "/etc/passwd")


def test_parent_traversal_is_refused(tmp_path: Path) -> None:
    root = tmp_path / "media"
    root.mkdir()
    (tmp_path / "secret.txt").write_bytes(b"x")

    with pytest.raises(ValueError):
        resolve_media(str(root), "../secret.txt")


def test_symlink_that_leaves_the_root_is_refused(tmp_path: Path) -> None:
    root = tmp_path / "media"
    root.mkdir()
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"x")
    (root / "link.mp4").symlink_to(outside)

    with pytest.raises(ValueError):
        resolve_media(str(root), "link.mp4")


def test_missing_file_is_reported(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        resolve_media(str(tmp_path), "nope.mp4")
