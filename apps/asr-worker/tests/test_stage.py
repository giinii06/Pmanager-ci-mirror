from __future__ import annotations

import pytest

from asr_worker.stage import build_parser


def test_the_parser_accepts_detect() -> None:
    args = build_parser().parse_args(
        [
            "detect",
            "--input",
            "chunks.json",
            "--output",
            "language.json",
            "--probe-dir",
            "/models/langid",
            "--pid-file",
            "/tmp/asr-stage.pid",
        ]
    )

    assert args.command == "detect"
    assert args.probe_dir == "/models/langid"
    assert args.samples == 5
    assert args.min_confidence == 0.60
    assert args.min_margin == 0.15


def test_detect_requires_a_probe_directory() -> None:
    with pytest.raises(SystemExit):
        build_parser().parse_args(
            ["detect", "--input", "chunks.json", "--output", "language.json", "--pid-file", "pid"]
        )
