from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

SENTENCE_END = ("?", "!", ".", "。", "？", "！", "…")


@dataclass(frozen=True)
class Segment:
    start_ms: int
    end_ms: int
    text: str

    def as_dict(self) -> dict[str, Any]:
        return {"startMs": self.start_ms, "endMs": self.end_ms, "text": self.text}


def _clock(ms: int, separator: str) -> str:
    total = max(0, int(round(ms)))
    hours, rest = divmod(total, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    seconds, millis = divmod(rest, 1_000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}{separator}{millis:03d}"


def vtt_timestamp(ms: int) -> str:
    return _clock(ms, ".")


def srt_timestamp(ms: int) -> str:
    return _clock(ms, ",")


def _flush(words: list[dict[str, Any]], chunk: dict[str, Any]) -> Segment | None:
    if not words:
        return None
    text = "".join(str(word["text"]) for word in words).strip()
    if not text:
        return None
    start = int(words[0]["start_ms"])
    end = int(words[-1]["end_ms"])
    if end <= start:
        end = min(start + 100, int(chunk["end_ms"]))
    start = max(int(chunk["start_ms"]), start)
    end = min(int(chunk["end_ms"]), max(start, end))
    return Segment(start_ms=start, end_ms=end, text=text)


def build_segments(
    chunks: Iterable[dict[str, Any]],
    max_chars: int = 42,
    max_duration_ms: int = 6_000,
    max_gap_ms: int = 800,
) -> list[Segment]:
    """
    Turn aligned words into subtitle lines. A chunk whose alignment failed has
    no words and contributes no cue, because a guessed timestamp is worse than
    a missing line.
    """
    segments: list[Segment] = []
    for chunk in chunks:
        words = chunk.get("words") or []
        if chunk.get("status") != "aligned" or not words:
            continue

        line: list[dict[str, Any]] = []
        line_chars = 0
        for word in words:
            text = str(word.get("text", "")).strip()
            if not text:
                continue

            if line:
                previous = line[-1]
                gap = int(word["start_ms"]) - int(previous["end_ms"])
                span = int(word["end_ms"]) - int(line[0]["start_ms"])
                too_long = line_chars + len(text) > max_chars
                too_slow = span > max_duration_ms
                if gap > max_gap_ms or too_long or too_slow:
                    segment = _flush(line, chunk)
                    if segment:
                        segments.append(segment)
                    line = []
                    line_chars = 0

            line.append(word)
            line_chars += len(text)

            joined = "".join(str(item["text"]) for item in line).strip()
            if joined.endswith(SENTENCE_END) and len(joined) >= 4:
                segment = _flush(line, chunk)
                if segment:
                    segments.append(segment)
                line = []
                line_chars = 0

        segment = _flush(line, chunk)
        if segment:
            segments.append(segment)

    segments.sort(key=lambda segment: (segment.start_ms, segment.end_ms))
    return segments


def to_vtt(segments: Iterable[Segment]) -> str:
    blocks = ["WEBVTT", ""]
    for index, segment in enumerate(segments, start=1):
        blocks.append(str(index))
        blocks.append(f"{vtt_timestamp(segment.start_ms)} --> {vtt_timestamp(segment.end_ms)}")
        blocks.append(segment.text)
        blocks.append("")
    return "\n".join(blocks)


def to_srt(segments: Iterable[Segment]) -> str:
    blocks: list[str] = []
    for index, segment in enumerate(segments, start=1):
        blocks.append(str(index))
        blocks.append(f"{srt_timestamp(segment.start_ms)} --> {srt_timestamp(segment.end_ms)}")
        blocks.append(segment.text)
        blocks.append("")
    return "\n".join(blocks)


def to_txt(segments: Iterable[Segment]) -> str:
    return "\n".join(segment.text for segment in segments)
