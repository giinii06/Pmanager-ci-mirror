from __future__ import annotations

from scene_worker.pipeline import parse_checkpoint


def test_a_checkpoint_line_yields_the_progress() -> None:
    digest = "a" * 64

    assert parse_checkpoint(f"CHECKPOINT 5 120 {digest}") == (5, 120, digest)


def test_other_stage_lines_are_not_checkpoints() -> None:
    assert parse_checkpoint("PROGRESS 0.5000") is None
    assert parse_checkpoint(f"CHECKPOINT 5 120 {'A' * 64}") is None
    assert parse_checkpoint("CHECKPOINT 5 120 nothex") is None
    assert parse_checkpoint("CHECKPOINT 5 120") is None
