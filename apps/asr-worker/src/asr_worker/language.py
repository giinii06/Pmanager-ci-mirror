"""The languages Qwen3-ASR reports, and the codes the library stores.

The model answers with canonical English names ("English", "Korean"), while a
transcript row and the subtitle picker use short tags. Keeping the two tables
together is what stops a detected language from being stamped with the code of
the hint that was passed in.
"""

from __future__ import annotations

from collections import Counter
from typing import Any, Iterable

# Every language Qwen3-ASR 0.0.6 supports. The code is what a transcript row
# stores and what the web UI names in Korean.
NAMES: dict[str, str] = {
    "zh": "Chinese",
    "en": "English",
    "yue": "Cantonese",
    "ar": "Arabic",
    "de": "German",
    "fr": "French",
    "es": "Spanish",
    "pt": "Portuguese",
    "id": "Indonesian",
    "it": "Italian",
    "ko": "Korean",
    "ru": "Russian",
    "th": "Thai",
    "vi": "Vietnamese",
    "ja": "Japanese",
    "tr": "Turkish",
    "hi": "Hindi",
    "ms": "Malay",
    "nl": "Dutch",
    "sv": "Swedish",
    "da": "Danish",
    "fi": "Finnish",
    "pl": "Polish",
    "cs": "Czech",
    "fil": "Filipino",
    "fa": "Persian",
    "el": "Greek",
    "ro": "Romanian",
    "hu": "Hungarian",
    "mk": "Macedonian",
}

CODES: dict[str, str] = {name.lower(): code for code, name in NAMES.items()}


def base_tag(value: str) -> str:
    return value.strip().lower().replace("_", "-").split("-")[0]


def language_hint(value: str | None) -> str | None:
    """The canonical name the model accepts, or None to let it detect.

    Accepts either a tag ("ko", "en-US") or a canonical name ("Korean").
    Anything else is passed through so the model rejects a typo loudly instead
    of silently transcribing in the wrong language.
    """
    text = (value or "").strip()
    if not text:
        return None
    base = base_tag(text)
    if base in NAMES:
        return NAMES[base]
    if base in CODES:
        return NAMES[CODES[base]]
    return text


def code_for(value: str | None) -> str | None:
    """The stored tag for a name the model reported, if it is one we know."""
    text = (value or "").strip()
    if not text:
        return None
    base = base_tag(text)
    if base in NAMES:
        return base
    return CODES.get(base)


def detect_language(chunks: Iterable[dict[str, Any]]) -> str | None:
    """The language most chunks were transcribed in, or None for silence.

    The model reports a name per chunk, and a mixed file can name more than one
    ("Chinese,English"), so every name counts and the majority wins.
    """
    counts: Counter[str] = Counter()
    for chunk in chunks:
        reported = str(chunk.get("language") or "")
        for part in reported.split(","):
            code = code_for(part)
            if code:
                counts[code] += 1
    if not counts:
        return None
    return counts.most_common(1)[0][0]
