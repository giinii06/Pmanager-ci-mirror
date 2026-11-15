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
    model_dir: str
    aligner_dir: str
    media_root: str
    result_dir: str
    temp_dir: str
    device: str
    language: str
    model_id: str
    aligner_id: str
    model_revision: str
    aligner_revision: str
    pipeline_version: str
    min_chunk_ms: int
    max_chunk_ms: int
    poll_seconds: float
    lease_ms: int
    gpu_wait_seconds: float
    offline: bool
    keep_workdir: bool


def load_config(env: dict[str, str] | None = None) -> Config:
    source = dict(os.environ if env is None else env)
    token = source.get("ASR_WORKER_TOKEN", "").strip()
    if not token:
        raise RuntimeError("ASR_WORKER_TOKEN is required.")

    return Config(
        api_base_url=source.get("API_BASE_URL", "http://127.0.0.1:8787").rstrip("/"),
        worker_token=token,
        worker_id=source.get("ASR_WORKER_ID", "").strip() or f"{socket.gethostname()}-{os.getpid()}",
        model_dir=source.get("ASR_MODEL_DIR", "/models/asr"),
        aligner_dir=source.get("ALIGN_MODEL_DIR", "/models/aligner"),
        media_root=source.get("MEDIA_ROOT", "/media"),
        result_dir=source.get("RESULT_DIR", "/asr-results"),
        temp_dir=source.get("ASR_TEMP_DIR", ""),
        device=source.get("ASR_DEVICE", "auto").strip().lower(),
        # An optional hint, not the stored language: the transcript keeps what
        # the model heard, so an English file is not labelled Korean.
        language=source.get("ASR_LANGUAGE", "").strip(),
        model_id=source.get("ASR_MODEL_ID", "TeamUNIVA/qwen3_asr_1.7b_ko"),
        aligner_id=source.get("ALIGN_MODEL_ID", "Qwen/Qwen3-ForcedAligner-0.6B"),
        model_revision=source.get("ASR_MODEL_REVISION", "main"),
        aligner_revision=source.get("ALIGN_MODEL_REVISION", "main"),
        pipeline_version=source.get("ASR_PIPELINE_VERSION", "1"),
        min_chunk_ms=_int(source, "ASR_MIN_CHUNK_MS", 15_000),
        max_chunk_ms=_int(source, "ASR_MAX_CHUNK_MS", 30_000),
        poll_seconds=_float(source, "ASR_POLL_SECONDS", 3.0),
        lease_ms=_int(source, "ASR_LEASE_MS", 120_000),
        gpu_wait_seconds=_float(source, "GPU_WAIT_SECONDS", 600.0),
        offline=source.get("HF_HUB_OFFLINE", "") == "1",
        keep_workdir=source.get("ASR_KEEP_WORKDIR", "") == "1",
    )
