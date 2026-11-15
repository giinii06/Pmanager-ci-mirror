from __future__ import annotations

import os
import socket
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    api_base_url: str
    worker_token: str
    worker_id: str
    model_dir: str
    model_id: str
    model_revision: str
    model_sha256: str
    dimensions: int
    sample_ms: int
    min_score: float
    temp_dir: str
    cache_dir: str
    lease_ms: int
    poll_seconds: float
    providers: str


def _int(source: dict[str, str], name: str, fallback: int) -> int:
    raw = source.get(name, "").strip()
    if not raw:
        return fallback
    try:
        return int(raw)
    except ValueError as error:
        raise SystemExit(f"{name} must be an integer, got {raw!r}") from error


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
    token = source.get("FACE_WORKER_TOKEN", "").strip()
    if len(token) < 16:
        raise SystemExit("FACE_WORKER_TOKEN must be at least 16 characters.")

    sample_ms = _int(source, "FACE_SAMPLE_MS", 2_000)
    if sample_ms < 250:
        raise SystemExit("FACE_SAMPLE_MS must be at least 250.")

    return Config(
        api_base_url=source.get("API_BASE_URL", "http://127.0.0.1:8787").rstrip("/"),
        worker_token=token,
        worker_id=source.get("FACE_WORKER_ID", "").strip() or f"{socket.gethostname()}-{os.getpid()}",
        model_dir=source.get("FACE_MODEL_DIR", "/models/face"),
        model_id=source.get("FACE_MODEL_ID", "antelopev2"),
        model_revision=source.get("FACE_MODEL_REVISION", "v0.7"),
        model_sha256=source.get("FACE_MODEL_SHA256", ""),
        dimensions=_int(source, "FACE_DIMENSIONS", 512),
        sample_ms=sample_ms,
        min_score=_float(source, "FACE_MIN_SCORE", 0.5),
        temp_dir=source.get("FACE_TEMP_DIR", "/face-tmp"),
        cache_dir=source.get("FACE_CACHE_DIR", "/cache"),
        lease_ms=_int(source, "FACE_LEASE_MS", 180_000),
        poll_seconds=_float(source, "FACE_POLL_SECONDS", 2.0),
        providers=source.get("FACE_PROVIDERS", "CPUExecutionProvider"),
    )
