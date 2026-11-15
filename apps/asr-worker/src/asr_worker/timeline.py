from __future__ import annotations

from typing import Any

# The aligner may wobble by a few hundred milliseconds inside one chunk. A
# bounded nudge keeps the timeline usable; anything larger means the output is
# untrustworthy, so the chunk is dropped instead of guessed at.
MAX_INVERSION_MS = 300


def clean_words(
    items: list[Any],
    chunk_start_ms: int,
    chunk_end_ms: int,
) -> tuple[list[dict[str, Any]], str | None]:
    """Map chunk-relative aligner output onto the global timeline."""
    words: list[dict[str, Any]] = []
    for item in items:
        text = str(item.text).strip()
        if not text:
            continue
        start = chunk_start_ms + int(round(float(item.start_time) * 1000))
        end = chunk_start_ms + int(round(float(item.end_time) * 1000))
        start = max(chunk_start_ms, min(chunk_end_ms, start))
        end = max(start, min(chunk_end_ms, end))
        if end <= start:
            continue
        words.append({"text": text, "start_ms": start, "end_ms": end})

    previous_end = -1
    for word in words:
        if word["start_ms"] < previous_end:
            if previous_end - word["start_ms"] > MAX_INVERSION_MS:
                return [], "non-monotonic timestamps"
            word["start_ms"] = previous_end
            if word["end_ms"] <= word["start_ms"]:
                word["end_ms"] = word["start_ms"] + 50
        previous_end = word["end_ms"]

    return words, None


def attach_source_text(words: list[dict[str, Any]], text: str) -> list[dict[str, Any]]:
    """
    Give every word the exact slice of the transcript it came from, separator
    included. The aligner tokenizes Korean into morphemes, so a plain space join
    would turn "고릴라가" into "고릴라 가". Slicing the original string keeps the
    spacing and punctuation the recognizer produced.

    Punctuation sitting between two tokens belongs to the sentence that just
    ended, so it is moved onto the previous word instead of leading the next
    one. Otherwise a line break could start a cue with "?".
    """
    cursor = 0
    for index, word in enumerate(words):
        token = str(word["text"])
        start = text.find(token, cursor)
        if start < 0:
            word["text"] = f" {token}" if cursor else token
            continue

        separator = text[cursor:start]
        if index > 0 and separator and not separator[0].isspace():
            lead = 0
            while lead < len(separator) and not separator[lead].isspace():
                lead += 1
            words[index - 1]["text"] = str(words[index - 1]["text"]) + separator[:lead]
            separator = separator[lead:]

        word["text"] = separator + text[start : start + len(token)]
        cursor = start + len(token)
    return words

