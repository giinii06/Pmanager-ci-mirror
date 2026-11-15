#!/usr/bin/env python3
"""Download the Index-Translate-9B GGUF file into a host-mounted model directory.

The image never contains weights. This script runs before the translation worker
starts, is idempotent, and publishes a file only after the SHA256 and the GGUF
magic match, so a failed or partial download never replaces a working model.

Transfers go through huggingface_hub, which uses the hf_xet backend for these
repositories. Xet downloads the file as concurrent chunks and assembles them,
instead of reading one HTTP stream from start to finish.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Mapping

from huggingface_hub import hf_hub_download

PREFIX = "[translation-model-init]"
MANIFEST_NAME = "model-manifest.json"
GGUF_MAGIC = b"GGUF"
DEFAULT_MODEL_ID = "IndexTeam/Index-Translate-9B-GGUF"
DEFAULT_FILENAME = "Index-Translate-9B.Q4_K_M.gguf"
CHUNK_BYTES = 4 * 1024 * 1024
REQUIRED_FREE_GB = 12.0
COMMIT_PATTERN = re.compile(r"[0-9a-f]{40}")
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
QUANTIZATION_PATTERN = re.compile(r"\.(Q\d+[A-Z0-9_]*|F16|F32|BF16)\.gguf$", re.IGNORECASE)


class InitError(Exception):
    """Something the operator has to fix. The entrypoint turns it into exit 1."""


def log(message: str) -> None:
    print(f"{PREFIX} {message}", flush=True)


@dataclass(frozen=True)
class Settings:
    repo_id: str
    filename: str
    revision: str
    sha256: str
    quantization: str
    models_dir: Path
    token: str | None = None


@dataclass(frozen=True)
class Paths:
    root: Path
    final: Path
    staging: Path
    archive: Path

    @classmethod
    def of(cls, settings: Settings) -> "Paths":
        root = settings.models_dir / "translation"
        return cls(
            root=root,
            final=root / settings.filename,
            staging=root / ".staging",
            archive=root / ".archive",
        )


def quantization_from(filename: str) -> str:
    match = QUANTIZATION_PATTERN.search(filename)
    return match.group(1).upper() if match else "unknown"


def settings_from_env(env: Mapping[str, str] | None = None) -> Settings:
    source = os.environ if env is None else env

    revision = source.get("TRANSLATION_MODEL_REVISION", "").strip()
    sha256 = source.get("TRANSLATION_MODEL_SHA256", "").strip().lower()
    filename = source.get("TRANSLATION_MODEL_FILENAME", "").strip() or DEFAULT_FILENAME
    quantization = source.get("TRANSLATION_MODEL_QUANTIZATION", "").strip()
    models_dir = source.get("MODELS_DIR", "").strip() or "/models"

    if not revision:
        raise InitError(
            "TRANSLATION_MODEL_REVISION is empty. Paste the 40-character commit SHA."
        )
    if not COMMIT_PATTERN.fullmatch(revision) and source.get("ALLOW_FLOATING_REVISION", "") != "1":
        raise InitError(
            f"TRANSLATION_MODEL_REVISION={revision!r} is not a 40-character commit SHA. "
            "A branch or tag can move under the same name, which makes the recorded "
            "revision a lie. Pin the commit, or set ALLOW_FLOATING_REVISION=1 for a "
            "throwaway check."
        )
    if not SHA256_PATTERN.fullmatch(sha256):
        raise InitError(
            "TRANSLATION_MODEL_SHA256 must be the 64-character hex digest of the file. "
            "Without it a truncated or swapped download cannot be detected."
        )

    return Settings(
        repo_id=source.get("TRANSLATION_MODEL_ID", "").strip() or DEFAULT_MODEL_ID,
        filename=filename,
        revision=revision,
        sha256=sha256,
        quantization=quantization or quantization_from(filename),
        models_dir=Path(models_dir),
        token=source.get("HF_TOKEN", "").strip() or None,
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(CHUNK_BYTES), b""):
            digest.update(block)
    return digest.hexdigest()


def gguf_header_ok(path: Path) -> bool:
    """The magic rules out an HTML error page or a different model saved under this name."""
    try:
        with path.open("rb") as stream:
            return stream.read(len(GGUF_MAGIC)) == GGUF_MAGIC
    except OSError:
        return False


def verify_file(path: Path, sha256: str, size: int | None = None) -> list[str]:
    """Returns the reasons the file cannot be trusted; an empty list means it can."""
    if not path.is_file():
        return ["file is missing"]
    if not gguf_header_ok(path):
        return ["not a GGUF file"]
    actual_size = path.stat().st_size
    if size is not None and actual_size != size:
        return [f"size is {actual_size} bytes, expected {size}"]
    actual = sha256_file(path)
    if actual != sha256:
        return [f"sha256 is {actual}, expected {sha256}"]
    return []


def read_manifest(paths: Paths) -> dict | None:
    path = paths.root / MANIFEST_NAME
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def write_manifest(paths: Paths, payload: dict) -> None:
    paths.root.mkdir(parents=True, exist_ok=True)
    target = paths.root / MANIFEST_NAME
    temporary = target.with_name(f"{MANIFEST_NAME}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(target)


def build_manifest(settings: Settings, size: int) -> dict:
    return {
        "repo": settings.repo_id,
        "revision": settings.revision,
        "filename": settings.filename,
        "sha256": settings.sha256,
        "size": size,
        "quantization": settings.quantization,
        "downloaded_at": datetime.now(timezone.utc).isoformat(),
    }


def expected_size(paths: Paths, settings: Settings) -> int | None:
    """The recorded size is only usable while it describes this exact digest."""
    manifest = read_manifest(paths)
    if not manifest or manifest.get("sha256") != settings.sha256:
        return None
    size = manifest.get("size")
    return size if isinstance(size, int) and size > 0 else None


def disk_free_gb(path: Path) -> float:
    probe = path
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    return shutil.disk_usage(probe).free / 1_000_000_000


def publish(staged: Path, paths: Paths) -> Path | None:
    """Swaps the verified file in with one rename and keeps the previous one.

    The old file is hard linked before the rename so the final path is never
    missing, and no 5.78 GB copy is made. Filesystems without hard links fall
    back to a move.
    """
    archived: Path | None = None
    if paths.final.exists():
        paths.archive.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        archived = paths.archive / f"{paths.final.name}-{stamp}"
        try:
            os.link(paths.final, archived)
        except OSError:
            shutil.move(str(paths.final), str(archived))
    paths.root.mkdir(parents=True, exist_ok=True)
    os.replace(staged, paths.final)
    return archived


def ensure_model(
    settings: Settings,
    *,
    download: Callable[..., str] | None = None,
    log_fn: Callable[[str], None] = log,
) -> Path:
    paths = Paths.of(settings)
    size = expected_size(paths, settings)

    if paths.final.is_file():
        problems = verify_file(paths.final, settings.sha256, size)
        if not problems:
            log_fn(f"{settings.filename} already verified at {paths.final}; nothing to download")
            if read_manifest(paths) is None:
                write_manifest(paths, build_manifest(settings, paths.final.stat().st_size))
            return paths.final
        log_fn(f"existing file failed verification ({'; '.join(problems)}); downloading again")

    free_gb = disk_free_gb(settings.models_dir)
    if free_gb < REQUIRED_FREE_GB:
        raise InitError(
            f"only {free_gb:.1f} GB free under {settings.models_dir}; need "
            f"{REQUIRED_FREE_GB:.0f} GB for the download plus the kept previous copy."
        )

    staging_root = paths.staging / str(os.getpid())
    staging_root.mkdir(parents=True, exist_ok=True)
    log_fn(f"downloading {settings.repo_id}@{settings.revision} through hf_xet")
    fetch = download or hf_hub_download
    try:
        staged = Path(
            fetch(
                repo_id=settings.repo_id,
                filename=settings.filename,
                revision=settings.revision,
                token=settings.token,
                local_dir=str(staging_root),
            )
        )
    except Exception as error:
        shutil.rmtree(staging_root, ignore_errors=True)
        message = str(error)
        gated = "gated" in message.lower() or "401" in message or "403" in message
        hint = " Is the repository gated? Set HF_TOKEN." if gated else ""
        raise InitError(f"download failed: {message}.{hint}") from error

    problems = verify_file(staged, settings.sha256)
    if problems:
        shutil.rmtree(staging_root, ignore_errors=True)
        raise InitError(f"downloaded file failed verification: {'; '.join(problems)}")

    written = staged.stat().st_size
    archived = publish(staged, paths)
    shutil.rmtree(staging_root, ignore_errors=True)
    if archived:
        log_fn(f"previous file kept at {archived}")
    write_manifest(paths, build_manifest(settings, written))
    log_fn(f"ready: {paths.final} ({written / 1e9:.2f} GB)")
    return paths.final


def main(env: Mapping[str, str] | None = None) -> int:
    try:
        ensure_model(settings_from_env(env))
    except InitError as error:
        print(f"{PREFIX} ERROR: {error}", file=sys.stderr, flush=True)
        return 1
    log("translation model verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
