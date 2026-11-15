"""The languages Qwen3-ASR reports, and the codes the library stores.

The base model names the language it heard, but a fine-tune can answer with
plain text only. When that happens the script of the text decides: Hangul is
Korean, kana is Japanese, Han is Chinese, and so on. Latin-script languages
share one script, so there the operator's hint wins and English is the default.
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

# Scripts that identify one language on their own, with the share of letters a
# stray word or a borrowed name must not outweigh.
SCRIPTS: tuple[tuple[str, str, float], ...] = (
    ("hangul", "ko", 0.2),
    ("kana", "ja", 0.1),
    ("han", "zh", 0.2),
    ("cyrillic", "ru", 0.2),
    ("arabic", "ar", 0.2),
    ("thai", "th", 0.2),
    ("devanagari", "hi", 0.2),
    ("greek", "el", 0.2),
)


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


def script_of(char: str) -> str | None:
    """The script family of one character, or None for digits and punctuation."""
    code = ord(char)
    if 0xAC00 <= code <= 0xD7A3 or 0x1100 <= code <= 0x11FF or 0x3130 <= code <= 0x318F:
        return "hangul"
    if 0x3040 <= code <= 0x30FF or 0x31F0 <= code <= 0x31FF:
        return "kana"
    if 0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF or 0xF900 <= code <= 0xFAFF:
        return "han"
    if 0x0400 <= code <= 0x04FF:
        return "cyrillic"
    if 0x0600 <= code <= 0x06FF or 0x0750 <= code <= 0x077F:
        return "arabic"
    if 0x0E00 <= code <= 0x0E7F:
        return "thai"
    if 0x0900 <= code <= 0x097F:
        return "devanagari"
    if 0x0370 <= code <= 0x03FF:
        return "greek"
    if char.isalpha():
        return "latin"
    return None


def detect_script(text: str) -> str | None:
    """The language a script points at, or None when the text is Latin or empty.

    Latin covers English, Spanish, French and the rest, so it is left for the
    caller to decide instead of guessing.
    """
    counts: Counter[str] = Counter()
    for char in text:
        script = script_of(char)
        if script:
            counts[script] += 1
    total = sum(counts.values())
    if total == 0:
        return None
    for script, code, share in SCRIPTS:
        if counts[script] / total >= share:
            return code
    return None


def detect_language(chunks: Iterable[dict[str, Any]]) -> str | None:
    """The language the model named for most chunks, or None when it named none.

    A mixed file can name more than one ("Chinese,English"), so every name
    counts and the majority wins.
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


def spoken_language(chunks: Iterable[dict[str, Any]], hint: str | None = None) -> str | None:
    """The code a transcript should store, or None when nothing was spoken.

    The model's own answer wins; otherwise the script of the text decides, and
    Latin text falls back to the operator's hint or English.
    """
    materialised = list(chunks)
    named = detect_language(materialised)
    if named:
        return named

    text = " ".join(str(chunk.get("text") or "") for chunk in materialised)
    if not any(char.isalpha() for char in text):
        return None
    return detect_script(text) or code_for(hint) or "en"
