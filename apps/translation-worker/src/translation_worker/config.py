from __future__ import annotations

import os
import socket
from dataclasses import dataclass


def _int(env: dict[str, str], name: str, default: int) -> int:
    raw = env.get(name, "").strip()
    if not raw:
        return default
    return int(raw)


def _float(env: dict[str, str], name: str, default: float) -> float:
    raw = env.get(name, "").strip()
    if not raw:
        return default
    return float(raw)


@dataclass(frozen=True)
class Config:
    api_base_url: str
    worker_token: str
    worker_id: str
    result_dir: str
    model_path: str
    llama_server: str
    llama_port: int
    llama_ctx: int
    llama_gpu_layers: int
    batch_segments: int
    llama_start_timeout: float
    request_timeout: float
    gpu_wait_seconds: float
    poll_seconds: float
    lease_ms: int


def load_config(env: dict[str, str] | None = None) -> Config:
    source = dict(os.environ if env is None else env)
    token = source.get("TRANSLATION_WORKER_TOKEN", "").strip()
    if not token:
        raise RuntimeError("TRANSLATION_WORKER_TOKEN is required.")
    model_path = source.get("TRANSLATION_MODEL_PATH", "").strip()
    if not model_path:
        raise RuntimeError("TRANSLATION_MODEL_PATH is required.")

    return Config(
        api_base_url=source.get("API_BASE_URL", "http://127.0.0.1:8787").rstrip("/"),
        worker_token=token,
        worker_id=source.get("WORKER_ID", "").strip() or f"{socket.gethostname()}-{os.getpid()}",
        result_dir=source.get("RESULT_DIR", "../../asr-results"),
        model_path=model_path,
        llama_server=source.get("LLAMA_SERVER", "llama-server").strip() or "llama-server",
        llama_port=_int(source, "LLAMA_PORT", 8089),
        llama_ctx=_int(source, "LLAMA_CTX", 4096),
        llama_gpu_layers=_int(source, "LLAMA_GPU_LAYERS", 99),
        batch_segments=_int(source, "TRANSLATION_BATCH_SEGMENTS", 8),
        llama_start_timeout=_float(source, "LLAMA_START_TIMEOUT", 180.0),
        request_timeout=_float(source, "REQUEST_TIMEOUT", 300.0),
        gpu_wait_seconds=_float(source, "GPU_WAIT_SECONDS", 600.0),
        poll_seconds=_float(source, "POLL_SECONDS", 3.0),
        lease_ms=_int(source, "LEASE_MS", 120_000),
    )
