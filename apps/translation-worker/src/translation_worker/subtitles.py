from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable


@dataclass(frozen=True)
class Cue:
    """One subtitle line. The translation keeps seq and both timings as given."""

    seq: int
    start_ms: int
    end_ms: int
    text: str

    def as_payload(self) -> dict[str, Any]:
        return {"seq": self.seq, "startMs": self.start_ms, "endMs": self.end_ms, "text": self.text}


def cues_from_segments(segments: Iterable[dict[str, Any]]) -> list[Cue]:
    """Read the source cues out of a claim response."""
    return [
        Cue(
            seq=int(segment["seq"]),
            start_ms=int(segment["startMs"]),
            end_ms=int(segment["endMs"]),
            text=str(segment["text"]),
        )
        for segment in segments
    ]


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


def to_vtt(cues: Iterable[Cue]) -> str:
    """
    WebVTT has no way to keep a cue on screen past its end, so the player drops
    the line in every silence. A cue end is exclusive, so ending each cue where
    the next one starts keeps the previous line visible with no overlap.
    """
    lines = list(cues)
    blocks = ["WEBVTT", ""]
    for index, cue in enumerate(lines):
        end = cue.end_ms
        if index + 1 < len(lines) and lines[index + 1].start_ms > end:
            end = lines[index + 1].start_ms
        blocks.append(str(index + 1))
        blocks.append(f"{vtt_timestamp(cue.start_ms)} --> {vtt_timestamp(end)}")
        blocks.append(cue.text)
        blocks.append("")
    return "\n".join(blocks)


def to_srt(cues: Iterable[Cue]) -> str:
    blocks: list[str] = []
    for index, cue in enumerate(cues, start=1):
        blocks.append(str(index))
        blocks.append(f"{srt_timestamp(cue.start_ms)} --> {srt_timestamp(cue.end_ms)}")
        blocks.append(cue.text)
        blocks.append("")
    return "\n".join(blocks)


def to_txt(cues: Iterable[Cue]) -> str:
    return "\n".join(cue.text for cue in cues)
