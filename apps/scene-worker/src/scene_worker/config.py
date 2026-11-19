from __future__ import annotations

import os
import socket
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    api_base_url: str
    worker_token: str
    worker_id: str
    media_root: str
    model_dir: str
    model_id: str
    model_revision: str
    model_sha256: str
    dimensions: int
    temp_dir: str
    cache_dir: str
    lease_ms: int
    poll_seconds: float
    gpu_wait_seconds: float
    max_windows: int
    stage_timeout_seconds: float = 3600.0
    checkpoint_dir: str = ""


def _int(source: dict[str, str], name: str, fallback: int) -> int:
    raw = source.get(name, "").strip()
    if not raw:
        return fallback
    try:
        value = int(raw)
    except ValueError as error:
        raise SystemExit(f"{name} must be an integer, got {raw!r}") from error
    return value


def _float(source: dict[str, str], name: str, fallback: float) -> float:
    raw = source.get(name, "").strip()
    if not raw:
        return fallback
    try:
        return float(raw)
    except ValueError as error:
        raise SystemExit(f"{name} must be a number, got {raw!r}") from error


def load_config(env: dict[str, str] | None = None) -> Config:
    source = dict(os.environ if env is None else env)
    token = source.get("SCENE_WORKER_TOKEN", "").strip()
    if len(token) < 16:
        raise SystemExit("SCENE_WORKER_TOKEN must be at least 16 characters.")

    cache_dir = source.get("SCENE_CACHE_DIR", "/cache")
    return Config(
        api_base_url=source.get("API_BASE_URL", "http://127.0.0.1:8787").rstrip("/"),
        worker_token=token,
        worker_id=source.get("SCENE_WORKER_ID", "").strip() or f"{socket.gethostname()}-{os.getpid()}",
        media_root=source.get("MEDIA_ROOT", "/media"),
        model_dir=source.get("SCENE_MODEL_DIR", "/models/scene"),
        model_id=source.get("SCENE_MODEL_ID", "facebook/pe-av-base-16-frame"),
        model_revision=source.get("SCENE_MODEL_REVISION", "main"),
        model_sha256=source.get("SCENE_MODEL_SHA256", ""),
        dimensions=_int(source, "SCENE_DIMENSIONS", 1024),
        temp_dir=source.get("SCENE_TEMP_DIR", "/scene-tmp"),
        cache_dir=cache_dir,
        lease_ms=_int(source, "SCENE_LEASE_MS", 120_000),
        poll_seconds=_float(source, "SCENE_POLL_SECONDS", 2.0),
        gpu_wait_seconds=_float(source, "SCENE_GPU_WAIT_SECONDS", 900.0),
        max_windows=_int(source, "SCENE_MAX_WINDOWS", 120),
        stage_timeout_seconds=_float(source, "SCENE_STAGE_TIMEOUT_SECONDS", 3600.0),
        checkpoint_dir=source.get("SCENE_CHECKPOINT_DIR", "").strip()
        or f"{cache_dir.rstrip('/')}/scene-checkpoints",
    )
