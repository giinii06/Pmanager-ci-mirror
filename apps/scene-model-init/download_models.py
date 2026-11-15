#!/usr/bin/env python3
"""Download the PE-AV checkpoint into the Hugging Face cache the worker reads.

The worker loads with `cache_dir=/models/scene` and `HF_HUB_OFFLINE=1`, so the
download must land in the standard `models--<org>--<name>/snapshots/<sha>`
layout. `snapshot_download(cache_dir=...)` produces exactly that and is
idempotent: a second run sees every blob and returns.
"""

from __future__ import annotations

import json
import os
import struct
import sys
from pathlib import Path

from huggingface_hub import HfApi, snapshot_download

MODEL_ROOT = Path(os.environ.get("MODEL_ROOT", "/models"))
REQUIRED_FILES = ("config.json", "preprocessor_config.json", "processor_config.json")
MIN_WEIGHT_BYTES = 1024 * 1024 * 1024


def log(message: str) -> None:
    print(f"[scene-model-init] {message}", flush=True)


def fail(message: str) -> None:
    print(f"[scene-model-init] ERROR: {message}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def safetensors_ok(path: Path) -> bool:
    size = path.stat().st_size
    if size < MIN_WEIGHT_BYTES:
        return False
    with path.open("rb") as stream:
        raw = stream.read(8)
        if len(raw) != 8:
            return False
        header_len = struct.unpack("<Q", raw)[0]
        if header_len <= 0 or header_len > 100 * 1024 * 1024:
            return False
        header = stream.read(header_len)
        if len(header) != header_len:
            return False
    try:
        json.loads(header.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    return True


def main() -> int:
    repo_id = os.environ.get("SCENE_MODEL_ID", "facebook/pe-av-base-16-frame").strip()
    revision = os.environ.get("SCENE_MODEL_REVISION", "").strip()
    token = os.environ.get("HF_TOKEN", "").strip() or None
    cache = MODEL_ROOT / "scene"

    if not revision:
        fail("SCENE_MODEL_REVISION must be pinned to a commit SHA.")

    cache.mkdir(parents=True, exist_ok=True)
    try:
        commit = HfApi(token=token).model_info(repo_id, revision=revision).sha
    except Exception as error:  # noqa: BLE001 - surface the hub error verbatim
        fail(f"cannot read {repo_id}@{revision}: {error}")

    log(f"downloading {repo_id}@{commit} into {cache}")
    try:
        snapshot = Path(
            snapshot_download(
                repo_id=repo_id,
                revision=commit,
                cache_dir=str(cache),
                token=token,
            )
        )
    except Exception as error:  # noqa: BLE001
        fail(f"download failed: {error}")

    problems: list[str] = []
    for name in REQUIRED_FILES:
        if not (snapshot / name).is_file():
            problems.append(f"missing {name}")
    weights = snapshot / "model.safetensors"
    if not weights.is_file():
        problems.append("missing model.safetensors")
    elif not safetensors_ok(weights):
        problems.append("model.safetensors is truncated or corrupt")
    if problems:
        fail(f"downloaded files failed verification: {', '.join(problems)}")

    log(f"ready at {snapshot}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
