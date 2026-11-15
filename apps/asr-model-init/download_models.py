#!/usr/bin/env python3
"""Download the ASR and aligner checkpoints into a host-mounted model directory.

The image never contains weights. This script runs at container start, is
idempotent, and swaps a verified download into place only after every required
file is present, so a failed or partial download never replaces a working set.
"""

from __future__ import annotations

import json
import os
import shutil
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path

from huggingface_hub import HfApi, snapshot_download

MODEL_ROOT = Path(os.environ.get("MODEL_ROOT", "/models"))
MANIFEST_NAME = "model-manifest.json"
REQUIRED_FILES = (
    "config.json",
    "model.safetensors",
    "preprocessor_config.json",
    "tokenizer_config.json",
)
MIN_WEIGHT_BYTES = 50 * 1024 * 1024


def log(message: str) -> None:
    print(f"[asr-model-init] {message}", flush=True)


def fail(message: str) -> None:
    print(f"[asr-model-init] ERROR: {message}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def safetensors_ok(path: Path) -> bool:
    """A truncated download fails here: the header length and JSON must parse."""
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


def inspect(directory: Path) -> list[str]:
    problems: list[str] = []
    for name in REQUIRED_FILES:
        path = directory / name
        if not path.is_file():
            problems.append(f"missing {name}")
    weights = directory / "model.safetensors"
    if weights.is_file() and not safetensors_ok(weights):
        problems.append("model.safetensors is truncated or corrupt")
    return problems


def read_manifest(directory: Path) -> dict | None:
    path = directory / MANIFEST_NAME
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def write_manifest(directory: Path, payload: dict) -> None:
    path = directory / MANIFEST_NAME
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def disk_free_gb(path: Path) -> float:
    probe = path
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    return shutil.disk_usage(probe).free / 1_000_000_000


def ensure_model(label: str, repo_id: str, revision: str, target: Path, token: str | None) -> None:
    if not repo_id:
        fail(f"{label}: the model id is empty.")

    manifest = read_manifest(target)
    if manifest and manifest.get("requestedRevision") == revision:
        problems = inspect(target)
        if not problems:
            log(f"{label}: {repo_id}@{manifest.get('commit', revision)} already present, skipping")
            return
        log(f"{label}: manifest matched but the files are incomplete ({', '.join(problems)})")

    free = disk_free_gb(MODEL_ROOT)
    if free < 8:
        fail(f"{label}: only {free:.1f} GB free under {MODEL_ROOT}; need at least 8 GB.")

    api = HfApi(token=token)
    try:
        info = api.model_info(repo_id, revision=revision)
    except Exception as error:  # noqa: BLE001 - surface the hub error verbatim
        fail(f"{label}: cannot read {repo_id}@{revision}: {error}")

    commit = info.sha
    log(f"{label}: downloading {repo_id}@{commit} into {target}")
    staging = MODEL_ROOT / ".staging" / f"{target.name}-{commit[:12]}"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)

    try:
        snapshot_download(
            repo_id=repo_id,
            revision=commit,
            local_dir=str(staging),
            token=token,
        )
    except Exception as error:  # noqa: BLE001
        shutil.rmtree(staging, ignore_errors=True)
        fail(f"{label}: download failed: {error}")

    problems = inspect(staging)
    if problems:
        shutil.rmtree(staging, ignore_errors=True)
        fail(f"{label}: downloaded files failed verification: {', '.join(problems)}")

    write_manifest(
        staging,
        {
            "modelId": repo_id,
            "requestedRevision": revision,
            "commit": commit,
            "downloadedAt": datetime.now(timezone.utc).isoformat(),
            "files": sorted(
                str(path.relative_to(staging))
                for path in staging.rglob("*")
                if path.is_file() and path.name != MANIFEST_NAME
            ),
        },
    )

    if target.exists():
        archive = MODEL_ROOT / ".archive" / f"{target.name}-{datetime.now(timezone.utc):%Y%m%d%H%M%S}"
        archive.parent.mkdir(parents=True, exist_ok=True)
        target.rename(archive)
        log(f"{label}: previous model moved to {archive}")

    target.parent.mkdir(parents=True, exist_ok=True)
    staging.rename(target)
    log(f"{label}: ready at {target}")


def main() -> int:
    asr_id = os.environ.get("ASR_MODEL_ID", "TeamUNIVA/qwen3_asr_1.7b_ko").strip()
    align_id = os.environ.get("ALIGN_MODEL_ID", "Qwen/Qwen3-ForcedAligner-0.6B").strip()
    asr_revision = os.environ.get("ASR_MODEL_REVISION", "").strip()
    align_revision = os.environ.get("ALIGN_MODEL_REVISION", "").strip()
    token = os.environ.get("HF_TOKEN", "").strip() or None

    if not asr_revision or not align_revision:
        fail("ASR_MODEL_REVISION and ALIGN_MODEL_REVISION must be pinned to a commit SHA.")

    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    ensure_model("asr", asr_id, asr_revision, MODEL_ROOT / "asr", token)
    ensure_model("aligner", align_id, align_revision, MODEL_ROOT / "aligner", token)

    log("all models verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
