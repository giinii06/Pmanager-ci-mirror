from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Callable

from .device import empty_cache, load_model
from .jsonio import write_json_atomic
from .language import language_hint
from .timeline import attach_source_text, clean_words

log = logging.getLogger(__name__)


def run(
    asr_path: Path,
    aligner_dir: str,
    device: str,
    language: str | None,
    output_path: Path,
    progress: Callable[[float], None] = lambda _fraction: None,
) -> dict[str, Any]:
    from qwen_asr import Qwen3ForcedAligner

    payload = json.loads(asr_path.read_text(encoding="utf-8"))
    chunks: list[dict[str, Any]] = payload["chunks"]
    lang = language_hint(language) or "Korean"

    model = load_model(Qwen3ForcedAligner.from_pretrained, aligner_dir, device, "aligner")

    aligned: list[dict[str, Any]] = []
    for index, chunk in enumerate(chunks):
        entry = {**chunk, "words": [], "align_error": None}
        text = str(chunk.get("text", "")).strip()
        if chunk.get("status") not in ("transcribed", "empty") or not text:
            entry["status"] = "aligned" if chunk.get("status") == "empty" else chunk.get("status")
            aligned.append(entry)
            progress((index + 1) / len(chunks))
            continue

        try:
            result = model.align(audio=chunk["wav"], text=text, language=lang)[0]
            words, problem = clean_words(
                list(result),
                int(chunk["start_ms"]),
                int(chunk["end_ms"]),
            )
            if problem:
                entry["status"] = "align_failed"
                entry["align_error"] = problem
            else:
                entry["status"] = "aligned"
                entry["words"] = attach_source_text(words, text)
        except Exception as error:  # noqa: BLE001 - a failed chunk is reported, not invented
            entry["status"] = "align_failed"
            entry["align_error"] = f"{type(error).__name__}: {error}"
            log.warning("alignment failed for chunk %s: %s", chunk.get("index", index), error)

        aligned.append(entry)
        write_json_atomic(output_path, {**payload, "chunks": aligned})
        progress((index + 1) / len(chunks))

    empty_cache(device)
    del model

    if not any(entry.get("words") for entry in aligned):
        raise RuntimeError("alignment produced no timestamps for any chunk")

    return {**payload, "chunks": aligned}
