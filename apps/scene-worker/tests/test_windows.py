from __future__ import annotations

import base64
import struct

import pytest

from scene_worker.config import load_config
from scene_worker.model import encode_vector, normalise
from scene_worker.pipeline import resolve_media_path
from scene_worker.stage import plan_windows


def test_a_short_file_is_one_window() -> None:
    assert plan_windows(4_000, 10_000, 2_000) == [(0, 4_000)]


def test_windows_cover_the_file_with_the_requested_overlap() -> None:
    windows = plan_windows(30_000, 10_000, 2_000)

    assert windows[0] == (0, 10_000)
    assert windows[1][0] == 8_000
    assert windows[-1][1] == 30_000
    for (_, end), (start, _) in zip(windows, windows[1:]):
        assert start == end - 2_000


def test_the_last_window_is_clipped_to_the_duration() -> None:
    windows = plan_windows(23_000, 10_000, 2_000)

    assert windows[-1] == (16_000, 23_000)


def test_a_file_with_no_duration_has_no_windows() -> None:
    assert plan_windows(0, 10_000, 2_000) == []


def test_overlap_equal_to_the_window_still_advances() -> None:
    windows = plan_windows(3_000, 1_000, 999)

    assert windows[0] == (0, 1_000)
    assert windows[1][0] == 1


def test_a_cap_bounds_the_windows_of_a_long_file() -> None:
    duration = 13_804_000

    windows = plan_windows(duration, 10_000, 2_000, 60)

    assert len(windows) == 60
    assert windows[0][0] == 0
    assert windows[-1][1] == duration
    overlaps = [end - start for (_, end), (start, _) in zip(windows, windows[1:])]
    assert len(set(overlaps)) == 1
    assert overlaps[0] > 0
    step = windows[1][0] - windows[0][0]
    assert overlaps[0] / step == pytest.approx(0.25, rel=1e-4)


def test_a_cap_the_plan_already_fits_changes_nothing() -> None:
    assert plan_windows(30_000, 10_000, 2_000, 60) == plan_windows(30_000, 10_000, 2_000)


def test_a_cap_of_zero_leaves_the_long_file_plan_unchanged() -> None:
    windows = plan_windows(13_804_000, 10_000, 2_000)

    assert plan_windows(13_804_000, 10_000, 2_000, 0) == windows
    assert len(windows) == 1726


def test_a_cap_of_one_is_a_single_window_over_the_file() -> None:
    assert plan_windows(13_804_000, 10_000, 2_000, 1) == [(0, 13_804_000)]


def test_normalise_returns_a_unit_vector() -> None:
    unit = normalise([3.0, 4.0])

    assert unit == [0.6, 0.8]


def test_a_zero_vector_is_refused() -> None:
    with pytest.raises(RuntimeError, match="zero vector"):
        normalise([0.0, 0.0])


def test_encode_vector_is_base64_little_endian_float32() -> None:
    payload = encode_vector([0.0, 0.6, 0.8])

    raw = base64.b64decode(payload)
    assert len(raw) == 12
    assert struct.unpack("<3f", raw) == (0.0, pytest.approx(0.6), pytest.approx(0.8))


def test_encode_vector_normalises_before_packing() -> None:
    payload = encode_vector([0.0, 6.0, 8.0])

    values = struct.unpack("<3f", base64.b64decode(payload))
    assert sum(value * value for value in values) == pytest.approx(1.0, abs=1e-6)


def test_media_paths_resolve_under_the_mounted_root() -> None:
    assert resolve_media_path("/media", "Videos/a.mp4") == "/media/Videos/a.mp4"


def test_an_absolute_media_path_is_left_alone() -> None:
    assert resolve_media_path("/media", "/mnt/d/a.mp4") == "/mnt/d/a.mp4"


def test_the_default_media_root_is_the_mount() -> None:
    config = load_config({"SCENE_WORKER_TOKEN": "token-token-token"})

    assert config.media_root == "/media"


def test_the_window_cap_defaults_to_60_and_honours_the_environment() -> None:
    assert load_config({"SCENE_WORKER_TOKEN": "token-token-token"}).max_windows == 60

    capped = load_config({"SCENE_WORKER_TOKEN": "token-token-token", "SCENE_MAX_WINDOWS": "12"})

    assert capped.max_windows == 12
