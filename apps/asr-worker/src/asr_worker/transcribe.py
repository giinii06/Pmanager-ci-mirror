from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Callable

from .device import empty_cache, load_model
from .jsonio import write_json_atomic
from .language import language_hint

log = logging.getLogger(__name__)


def run(
    chunks_path: Path,
    model_dir: str,
    device: str,
    language: str | None,
    output_path: Path,
    progress: Callable[[float], None] = lambda _fraction: None,
) -> dict[str, Any]:
    from qwen_asr import Qwen3ASRModel

    plan = json.loads(chunks_path.read_text(encoding="utf-8"))
    chunks: list[dict[str, Any]] = plan["chunks"]
    # An empty hint lets the model detect the language per chunk, which is what
    # keeps an English file from being labelled Korean.
    lang = language_hint(language)

    model = load_model(Qwen3ASRModel.from_pretrained, model_dir, device, "asr")
    payload: dict[str, Any] = {
        "model_id": plan.get("model_id"),
        "model_revision": plan.get("model_revision"),
        "device": device,
        "language": lang,
        "chunks": [],
    }

    first_error: str | None = None
    for index, chunk in enumerate(chunks):
        entry = {**chunk, "status": "empty", "text": "", "error": None}
        try:
            result = model.transcribe(audio=chunk["wav"], language=lang)[0]
            entry["text"] = result.text.strip()
            entry["language"] = result.language
            entry["status"] = "transcribed" if entry["text"] else "empty"
        except Exception as error:  # noqa: BLE001 - one bad chunk must not kill the job
            entry["status"] = "failed"
            entry["error"] = f"{type(error).__name__}: {error}"
            first_error = first_error or entry["error"]
            log.warning("chunk %s failed: %s", chunk.get("index", index), entry["error"])

        payload["chunks"].append(entry)
        write_json_atomic(output_path, payload)
        progress((index + 1) / len(chunks))

    empty_cache(device)
    del model

    if all(entry["status"] == "failed" for entry in payload["chunks"]):
        raise RuntimeError(first_error or "every chunk failed to transcribe")

    return payload
