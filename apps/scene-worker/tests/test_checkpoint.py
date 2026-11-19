from __future__ import annotations

import json
from pathlib import Path

from scene_worker import checkpoint as checkpoint_module
from scene_worker.checkpoint import WindowCheckpoint


def meta(total: int = 12, **overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "assetId": "asset1",
        "fileVersion": 1,
        "modelSha256": "sha",
        "pipelineVersion": "scene-1",
        "dimensions": 4,
        "durationMs": 120_000,
        "windowMs": 10_000,
        "overlapMs": 0,
        "maxWindows": 0,
        "totalUnits": total,
    }
    values.update(overrides)
    return values


def window(seq: int, thumbnails: Path, *, thumbnail: bool = True) -> dict[str, object]:
    relative = f"scenes/asset1/{seq:04d}.jpg"
    if thumbnail:
        (thumbnails / relative).parent.mkdir(parents=True, exist_ok=True)
        (thumbnails / relative).write_bytes(b"jpeg")
    return {
        "seq": seq,
        "startMs": seq * 10_000,
        "endMs": (seq + 1) * 10_000,
        "thumbnailPath": relative,
        "visual": "visual",
        "audio": "audio",
        "av": "joint",
    }


def open_checkpoint(root: Path, thumbnails: Path, **overrides: object) -> WindowCheckpoint:
    return WindowCheckpoint(root, meta(**overrides), thumbnail_root=thumbnails)


def test_finished_windows_survive_a_restart(tmp_path: Path) -> None:
    thumbnails = tmp_path / "cache"
    first = open_checkpoint(tmp_path / "job1", thumbnails)
    for seq in range(5):
        first.append(window(seq, thumbnails))
    digest = first.digest

    second = open_checkpoint(tmp_path / "job1", thumbnails)

    assert second.completed == 5
    assert second.resumed == 5
    assert second.digest == digest
    assert [record["seq"] for record in second.scenes] == [0, 1, 2, 3, 4]


def test_the_manifest_is_written_every_five_windows(tmp_path: Path) -> None:
    thumbnails = tmp_path / "cache"
    checkpoint = open_checkpoint(tmp_path / "job1", thumbnails)

    written = [checkpoint.append(window(seq, thumbnails)) for seq in range(5)]

    assert written == [False, False, False, False, True]
    manifest = json.loads((tmp_path / "job1" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["completedUnits"] == 5
    assert manifest["hash"] == checkpoint.digest


def test_a_torn_tail_is_dropped_before_the_next_append(tmp_path: Path) -> None:
    thumbnails = tmp_path / "cache"
    first = open_checkpoint(tmp_path / "job1", thumbnails)
    for seq in range(5):
        first.append(window(seq, thumbnails))
    with (tmp_path / "job1" / "windows.jsonl").open("ab") as stream:
        stream.write(b'{"seq":5,"startMs":')

    second = open_checkpoint(tmp_path / "job1", thumbnails)
    assert second.completed == 5

    second.append(window(5, thumbnails))
    third = open_checkpoint(tmp_path / "job1", thumbnails)
    assert [record["seq"] for record in third.scenes] == [0, 1, 2, 3, 4, 5]


def test_a_missing_thumbnail_ends_the_prefix(tmp_path: Path) -> None:
    thumbnails = tmp_path / "cache"
    first = open_checkpoint(tmp_path / "job1", thumbnails)
    for seq in range(5):
        first.append(window(seq, thumbnails))
    (thumbnails / "scenes/asset1/0003.jpg").unlink()

    second = open_checkpoint(tmp_path / "job1", thumbnails)

    assert second.completed == 3
    assert (tmp_path / "job1" / "windows.jsonl").read_bytes().count(b"\n") == 3
    manifest = json.loads((tmp_path / "job1" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["completedUnits"] == 3


def test_a_manifest_from_another_model_is_discarded(tmp_path: Path) -> None:
    thumbnails = tmp_path / "cache"
    first = open_checkpoint(tmp_path / "job1", thumbnails)
    for seq in range(5):
        first.append(window(seq, thumbnails))

    second = open_checkpoint(tmp_path / "job1", thumbnails, modelSha256="another-sha")

    assert second.completed == 0
    assert not (tmp_path / "job1" / "windows.jsonl").exists()


def test_the_log_wins_over_a_manifest_that_lags(tmp_path: Path) -> None:
    thumbnails = tmp_path / "cache"
    first = open_checkpoint(tmp_path / "job1", thumbnails)
    for seq in range(6):
        first.append(window(seq, thumbnails))
    manifest = json.loads((tmp_path / "job1" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["completedUnits"] == 5

    second = open_checkpoint(tmp_path / "job1", thumbnails)

    assert second.completed == 6
    rewritten = json.loads((tmp_path / "job1" / "manifest.json").read_text(encoding="utf-8"))
    assert rewritten["completedUnits"] == 6
    assert rewritten["hash"] == second.digest


def test_the_prefix_stops_at_the_planned_total(tmp_path: Path) -> None:
    thumbnails = tmp_path / "cache"
    first = open_checkpoint(tmp_path / "job1", thumbnails, totalUnits=5)
    for seq in range(6):
        first.append(window(seq, thumbnails))

    second = open_checkpoint(tmp_path / "job1", thumbnails, totalUnits=5)

    assert second.completed == 5
    assert (tmp_path / "job1" / "windows.jsonl").read_bytes().count(b"\n") == 5


def test_the_checkpoint_line_carries_the_digest(tmp_path: Path) -> None:
    thumbnails = tmp_path / "cache"
    checkpoint = open_checkpoint(tmp_path / "job1", thumbnails)
    for seq in range(5):
        checkpoint.append(window(seq, thumbnails))

    assert checkpoint.checkpoint_line() == f"CHECKPOINT 5 12 {checkpoint.digest}"


def test_every_five_windows_is_one_manifest_write(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(checkpoint_module, "CHECKPOINT_EVERY", 2)
    thumbnails = tmp_path / "cache"
    checkpoint = open_checkpoint(tmp_path / "job1", thumbnails)

    written = [checkpoint.append(window(seq, thumbnails)) for seq in range(3)]

    assert written == [False, True, False]
