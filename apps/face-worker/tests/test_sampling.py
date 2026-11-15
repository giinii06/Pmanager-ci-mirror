from __future__ import annotations

import base64
import struct

import pytest

from face_worker.config import load_config
from face_worker.pipeline import resolve_media_path
from face_worker.stage import crop_face, encode_vector, plan_sampling


def test_sampling_uses_the_requested_interval_for_a_short_video() -> None:
    count, interval = plan_sampling(20_000, 2_000)

    assert (count, interval) == (10, 2_000)


def test_sampling_doubles_the_interval_until_the_count_fits() -> None:
    count, interval = plan_sampling(3_600_000, 2_000)

    assert count <= 900
    assert interval > 2_000
    assert count == 3_600_000 // interval


def test_a_video_with_no_duration_samples_nothing() -> None:
    assert plan_sampling(0, 2_000) == (0, 2_000)


def test_the_interval_never_drops_below_a_quarter_second() -> None:
    _, interval = plan_sampling(10_000, 10)

    assert interval == 250


def test_encode_vector_is_base64_little_endian_float32() -> None:
    payload = encode_vector([0.0, 0.6, 0.8])

    raw = base64.b64decode(payload)
    assert struct.unpack("<3f", raw) == (0.0, pytest.approx(0.6), pytest.approx(0.8))


def test_crop_face_writes_a_square_thumbnail(tmp_path) -> None:
    from PIL import Image

    image = Image.new("RGB", (640, 360), (10, 20, 30))
    dest = tmp_path / "faces" / "asset" / "000001000-0.jpg"

    crop_face(image, (300, 100, 380, 200), dest)

    assert dest.is_file()
    with Image.open(dest) as thumb:
        assert thumb.size == (160, 160)


def test_a_box_outside_the_frame_writes_nothing(tmp_path) -> None:
    from PIL import Image

    image = Image.new("RGB", (640, 360), (10, 20, 30))
    dest = tmp_path / "faces" / "asset" / "000001000-0.jpg"

    crop_face(image, (900, 500, 950, 560), dest)

    assert not dest.exists()


def test_a_short_token_is_refused() -> None:
    with pytest.raises(SystemExit, match="at least 16"):
        load_config({"FACE_WORKER_TOKEN": "short"})


def test_the_defaults_keep_faces_on_the_cpu() -> None:
    config = load_config({"FACE_WORKER_TOKEN": "token-token-token"})

    assert config.providers == "CPUExecutionProvider"
    assert config.sample_ms == 2_000
    assert config.dimensions == 512
    assert config.worker_id


def test_media_paths_resolve_under_the_mounted_root() -> None:
    assert resolve_media_path("/media", "Videos/a.mp4") == "/media/Videos/a.mp4"


def test_an_absolute_media_path_is_left_alone() -> None:
    assert resolve_media_path("/media", "/mnt/d/a.mp4") == "/mnt/d/a.mp4"


def test_the_default_media_root_is_the_mount() -> None:
    config = load_config({"FACE_WORKER_TOKEN": "token-token-token"})

    assert config.media_root == "/media"
