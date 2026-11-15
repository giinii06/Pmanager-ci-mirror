#!/usr/bin/env python3
"""Download the AntelopeV2 ONNX pack into the directory insightface expects.

`FaceAnalysis(name="antelopev2", root="/models/face")` looks in
`/models/face/models/antelopev2`, and insightface only auto-downloads the
buffalo packs. This script fetches the v0.7 release zip, unpacks it into a
staging directory, verifies the two ONNX files the worker actually loads, and
only then swaps it into place.
"""

from __future__ import annotations

import os
import shutil
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

MODEL_ROOT = Path(os.environ.get("MODEL_ROOT", "/models"))
PACK_NAME = "antelopev2"
RELEASE_URL = "https://github.com/deepinsight/insightface/releases/download/{revision}/{pack}.zip"
REQUIRED_FILES = ("scrfd_10g_bnkps.onnx", "glintr100.onnx")


def log(message: str) -> None:
    print(f"[face-model-init] {message}", flush=True)


def fail(message: str) -> None:
    print(f"[face-model-init] ERROR: {message}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def main() -> int:
    pack = os.environ.get("FACE_MODEL_ID", PACK_NAME).strip() or PACK_NAME
    revision = os.environ.get("FACE_MODEL_REVISION", "").strip()
    target = MODEL_ROOT / "face" / "models" / pack

    if not revision:
        fail("FACE_MODEL_REVISION must be pinned to a release tag such as v0.7.")

    if target.is_dir() and all((target / name).is_file() for name in REQUIRED_FILES):
        log(f"{pack}@{revision} already present at {target}, skipping")
        return 0

    url = RELEASE_URL.format(revision=revision, pack=pack)
    staging = MODEL_ROOT / "face" / ".staging" / f"{pack}-{revision}"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)
    archive = staging / f"{pack}.zip"

    log(f"downloading {url}")
    try:
        with urllib.request.urlopen(url, timeout=120) as response, archive.open("wb") as out:
            shutil.copyfileobj(response, out)
    except Exception as error:  # noqa: BLE001 - surface the download error verbatim
        shutil.rmtree(staging, ignore_errors=True)
        fail(f"download failed: {error}")

    log(f"unpacking {archive.stat().st_size // (1024 * 1024)} MB")
    try:
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(staging / "unpacked")
    except zipfile.BadZipFile as error:
        shutil.rmtree(staging, ignore_errors=True)
        fail(f"the download is not a zip archive: {error}")

    unpacked = staging / "unpacked"
    # The zip holds a single top-level directory named after the pack.
    source = unpacked / pack if (unpacked / pack).is_dir() else unpacked
    missing = [name for name in REQUIRED_FILES if not (source / name).is_file()]
    if missing:
        shutil.rmtree(staging, ignore_errors=True)
        fail(f"the archive is missing {', '.join(missing)}")

    if target.exists():
        archive_dir = MODEL_ROOT / "face" / ".archive" / f"{pack}-{datetime.now(timezone.utc):%Y%m%d%H%M%S}"
        archive_dir.parent.mkdir(parents=True, exist_ok=True)
        target.rename(archive_dir)
        log(f"previous pack moved to {archive_dir}")

    target.parent.mkdir(parents=True, exist_ok=True)
    source.rename(target)
    shutil.rmtree(staging, ignore_errors=True)
    log(f"{pack}@{revision} ready at {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
