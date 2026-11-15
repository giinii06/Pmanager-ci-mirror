from __future__ import annotations

import argparse
import logging
import warnings
import sys
from pathlib import Path

from .stage_pid import clear_self, record_self


def _progress(fraction: float) -> None:
    print(f"PROGRESS {max(0.0, min(1.0, fraction)):.4f}", flush=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="asr_worker.stage")
    sub = parser.add_subparsers(dest="command", required=True)

    asr = sub.add_parser("transcribe", help="transcribe prepared chunks")
    asr.add_argument("--input", required=True)
    asr.add_argument("--output", required=True)
    asr.add_argument("--model-dir", required=True)
    asr.add_argument("--device", required=True)
    asr.add_argument("--language", default="ko")
    asr.add_argument("--pid-file", required=True)

    forced = sub.add_parser("align", help="align an ASR checkpoint")
    forced.add_argument("--input", required=True)
    forced.add_argument("--output", required=True)
    forced.add_argument("--aligner-dir", required=True)
    forced.add_argument("--device", required=True)
    forced.add_argument("--language", default="ko")
    forced.add_argument("--pid-file", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    warnings.filterwarnings("ignore", category=SyntaxWarning)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    args = build_parser().parse_args(argv)

    # Both stage modules import `device`, which imports torch at module scope, so the
    # record has to land before the branch that could allocate on the card.
    record_self(Path(args.pid_file))
    try:
        if args.command == "transcribe":
            from . import transcribe

            transcribe.run(
                Path(args.input),
                args.model_dir,
                args.device,
                args.language,
                Path(args.output),
                _progress,
            )
        else:
            from . import align

            align.run(
                Path(args.input),
                args.aligner_dir,
                args.device,
                args.language,
                Path(args.output),
                _progress,
            )
    finally:
        clear_self(Path(args.pid_file))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
