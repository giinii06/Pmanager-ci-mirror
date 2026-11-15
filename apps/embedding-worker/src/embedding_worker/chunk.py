from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable


@dataclass(frozen=True)
class Chunk:
    """One embedded passage, with the span its source cues covered."""

    index: int
    start_ms: int
    end_ms: int
    text: str


def plan_chunks(segments: Iterable[dict[str, Any]], max_chars: int = 1200) -> list[Chunk]:
    """
    Packs consecutive cues into passages under a character budget. A cue is
    never split, so one that is already over budget becomes its own chunk.
    """
    chunks: list[Chunk] = []
    current: list[str] = []
    start_ms = 0
    end_ms = 0
    length = 0

    for segment in segments:
        text = str(segment["text"]).strip()
        if not text:
            continue
        if current and length + 1 + len(text) > max_chars:
            chunks.append(Chunk(len(chunks), start_ms, end_ms, " ".join(current)))
            current = []
            length = 0
        if current:
            length += 1 + len(text)
        else:
            start_ms = int(segment["startMs"])
            length = len(text)
        current.append(text)
        end_ms = int(segment["endMs"])

    if current:
        chunks.append(Chunk(len(chunks), start_ms, end_ms, " ".join(current)))
    return chunks
