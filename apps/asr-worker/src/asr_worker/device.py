from __future__ import annotations

import logging
from typing import Any, Callable

import torch

log = logging.getLogger(__name__)


def detect_device(preference: str = "auto") -> str:
    """Resolve the compute backend, refusing a request the host cannot honour."""
    if preference in ("cuda", "mps", "cpu"):
        chosen = preference
    else:
        if torch.cuda.is_available():
            chosen = "cuda"
        elif torch.backends.mps.is_available():
            chosen = "mps"
        else:
            chosen = "cpu"

    if chosen == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("ASR_DEVICE=cuda but CUDA is not available in this environment.")
    if chosen == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("ASR_DEVICE=mps but MPS is not available on this machine.")
    return chosen


def dtype_for(device: str) -> torch.dtype:
    if device == "cuda":
        return torch.bfloat16
    if device == "mps":
        return torch.float16
    return torch.float32


def empty_cache(device: str) -> None:
    if device == "cuda":
        torch.cuda.empty_cache()
    elif device == "mps":
        torch.mps.empty_cache()


def load_model(
    loader: Callable[..., Any],
    path: str,
    device: str,
    label: str,
) -> Any:
    """
    Load on the target device, falling back to CPU placement when the
    accelerator cannot hold the model. The caller gets a warning it can log
    rather than a crash.
    """
    dtype = dtype_for(device)
    try:
        return loader(path, dtype=dtype, device_map=device)
    except Exception as error:  # noqa: BLE001 - the backend error types vary
        if device == "cpu":
            raise
        log.warning("%s: device_map=%s failed (%s), retrying with .to(%s)", label, device, error, device)
        model = loader(path, dtype=dtype)
        model.model.to(device)
        return model
