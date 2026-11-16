"""Classify the spoken language with Whisper before transcription runs.

The probe is CPU-only and deliberately separate from the ASR model. A fine-tune
that answers in the wrong language cannot be trusted to name the right one, and
loading a second model family into the transcribe process would put two sets of
weights on the card at once.

Nothing heavy is imported at module scope, so `import asr_worker.probe` stays
cheap and torch-free.
"""

from __future__ import annotations

import json
import logging
import os
import wave
from pathlib import Path
from typing import Any, Callable

from .jsonio import write_json_atomic
from .language import Sample, decide, fold_whisper

log = logging.getLogger(__name__)

SAMPLE_RATE = 16_000


def read_pcm16(path: Path, limit_ms: int = 30_000) -> Any:
    """The first `limit_ms` of a 16-bit PCM wav as mono float32 in [-1, 1]."""
    import numpy as np

    with wave.open(str(path), "rb") as stream:
        channels = stream.getnchannels()
        width = stream.getsampwidth()
        rate = stream.getframerate()
        frames = min(stream.getnframes(), int(rate * limit_ms / 1000))
        raw = stream.readframes(frames)

    if width != 2:
        raise ValueError(f"{path} is not 16-bit PCM")
    if rate != SAMPLE_RATE:
        raise ValueError(f"{path} is {rate} Hz, not {SAMPLE_RATE}")
    data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    return data


def pick_samples(chunks: list[dict[str, Any]], count: int) -> list[int]:
    """Evenly spread chunk indices, so one loud section cannot decide the file."""
    total = len(chunks)
    if total == 0 or count <= 0:
        return []
    if total <= count:
        return list(range(total))
    if count == 1:
        return [0]
    last = total - 1
    return sorted({index * last // (count - 1) for index in range(count)})


def classify(model: Any, processor: Any, wav: Any) -> dict[str, float]:
    """The Whisper language distribution for one window.

    Only the first decoder position is needed, so the encoder and a single
    decoder step replace a full generate() call.
    """
    import torch

    features = processor(wav, sampling_rate=SAMPLE_RATE, return_tensors="pt")["input_features"]
    tokens = model.generation_config.lang_to_id
    codes = [token.strip("<|>") for token in tokens]
    start = torch.tensor([[model.generation_config.decoder_start_token_id]])
    with torch.no_grad():
        hidden = model.model.encoder(features).last_hidden_state
        decoded = model.model.decoder(start, encoder_hidden_states=hidden).last_hidden_state
        logits = model.proj_out(decoded)[0, 0]
        chosen = logits[[tokens[token] for token in tokens]].float()
        probabilities = torch.softmax(chosen, dim=-1)
    return {code: float(value) for code, value in zip(codes, probabilities)}


def _provenance(directory: Path) -> tuple[str, str]:
    """The probe model and commit, from the downloader's manifest when present."""
    try:
        manifest = json.loads((directory / "model-manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        manifest = {}
    model_id = str(manifest.get("modelId") or os.environ.get("LANGID_MODEL_ID", ""))
    revision = str(manifest.get("commit") or os.environ.get("LANGID_MODEL_REVISION", ""))
    return model_id, revision


def run(
    chunks_path: Path,
    probe_dir: str,
    samples: int,
    min_confidence: float,
    min_margin: float,
    output_path: Path,
    progress: Callable[[float], None] = lambda _fraction: None,
) -> dict[str, Any]:
    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    plan = json.loads(chunks_path.read_text(encoding="utf-8"))
    chunks: list[dict[str, Any]] = plan["chunks"]
    directory = Path(probe_dir)
    model_id, revision = _provenance(directory)

    model = WhisperForConditionalGeneration.from_pretrained(
        directory, local_files_only=True, dtype=torch.float32
    )
    model.eval()
    processor = WhisperProcessor.from_pretrained(directory, local_files_only=True)

    picked = pick_samples(chunks, samples)
    measured: list[Sample] = []
    for position, index in enumerate(picked, start=1):
        chunk = chunks[index]
        try:
            wav = read_pcm16(Path(str(chunk["wav"])))
            probabilities, unsupported = fold_whisper(classify(model, processor, wav))
        except Exception as error:  # noqa: BLE001 - one unreadable window must not sink the probe
            log.warning("language probe skipped chunk %s: %s", chunk.get("index", index), error)
            progress(position / len(picked))
            continue
        measured.append(
            Sample(
                index=int(chunk.get("index", index)),
                start_ms=int(chunk["start_ms"]),
                end_ms=int(chunk["end_ms"]),
                probabilities=probabilities,
                unsupported=unsupported,
            )
        )
        progress(position / len(picked))

    if not measured:
        raise RuntimeError("the language probe could not classify a single sample")

    decision = decide(
        measured,
        min_confidence=min_confidence,
        min_margin=min_margin,
        probe_model_id=model_id,
        probe_model_revision=revision,
    )
    payload = decision.as_dict()
    write_json_atomic(output_path, payload)
    return payload
