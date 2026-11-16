"""The languages Qwen3-ASR reports, and the codes the library stores.

The base model names the language it heard, but a fine-tune can answer with
plain text only, and a Korean fine-tune reading Japanese speech answers in
Hangul. A Whisper probe therefore settles the spoken language before
transcription runs. The script of the text only remains as a last resort for
the aligner, where a wrong language costs timing rather than text.

Everything here is torch-free, so the policy is testable without a model.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
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

# Whisper spells Filipino "tl". Every other Whisper code either matches NAMES or
# names a language Qwen3-ASR cannot transcribe at all.
WHISPER_ALIASES: dict[str, str] = {"tl": "fil"}

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


def fold_whisper(scores: dict[str, float]) -> tuple[dict[str, float], float]:
    """Split a Whisper distribution into codes we store and mass we cannot.

    A code outside NAMES is not folded into a neighbour, because the probe is
    often sure about a language this library has no track for.
    """
    supported: dict[str, float] = {}
    unsupported = 0.0
    for code, value in scores.items():
        base = base_tag(code.strip("<|>"))
        folded = WHISPER_ALIASES.get(base, base)
        if folded in NAMES:
            supported[folded] = supported.get(folded, 0.0) + value
        else:
            unsupported += value
    return supported, unsupported


def has_speech(chunks: Iterable[dict[str, Any]]) -> bool:
    """Whether the ASR text contains a letter at all.

    Silence, music and sound effects come back as empty strings or punctuation,
    and a transcript of those is not a subtitle track.
    """
    return any(char.isalpha() for chunk in chunks for char in str(chunk.get("text") or ""))


@dataclass(frozen=True)
class Sample:
    """One probed window and the distribution the probe returned for it."""

    index: int
    start_ms: int
    end_ms: int
    probabilities: dict[str, float]  # supported codes only
    unsupported: float  # mass outside NAMES

    def as_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "startMs": self.start_ms,
            "endMs": self.end_ms,
            "probabilities": dict(self.probabilities),
            "unsupported": self.unsupported,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> Sample:
        return cls(
            index=int(payload["index"]),
            start_ms=int(payload["startMs"]),
            end_ms=int(payload["endMs"]),
            probabilities={
                str(code): float(value)
                for code, value in (payload.get("probabilities") or {}).items()
            },
            unsupported=float(payload.get("unsupported") or 0.0),
        )


@dataclass(frozen=True)
class LanguageDecision:
    """The language the probe settled on, and the evidence that settled it.

    `force` is what the model is told to speak, `language` is what the library
    claims was spoken. They differ only when the evidence is good enough to
    steer the model and not good enough to label the file.
    """

    state: str  # accepted | uncertain | unsupported | probe-failed | hint
    language: str  # stored and claimed; "" unless accepted or hint
    force: str  # handed to transcribe; "" only when nothing is worth forcing
    top: str  # best supported code over the averaged samples; "" without samples
    runner_up: str
    confidence: float
    margin: float
    unsupported: float
    samples: tuple[Sample, ...]
    probe_model_id: str
    probe_model_revision: str
    hint: str  # raw ASR_LANGUAGE when the operator set one
    detail: str  # why the probe failed

    def __post_init__(self) -> None:
        if self.language and self.language not in NAMES:
            raise ValueError(f"unsupported language {self.language!r}")
        if self.force and self.force not in NAMES:
            raise ValueError(f"unsupported language {self.force!r}")
        legal = {
            "accepted": bool(self.top) and self.language == self.force == self.top,
            "hint": bool(self.language) and self.language == self.force == self.top,
            "uncertain": self.language == "" and bool(self.top) and self.force == self.top,
            "unsupported": self.language == self.force == "",
            "probe-failed": self.language == self.force == "",
        }
        if not legal.get(self.state, False):
            raise ValueError(
                f"illegal {self.state} decision: language={self.language!r} "
                f"force={self.force!r} top={self.top!r}"
            )

    def as_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "language": self.language,
            "force": self.force,
            "top": self.top,
            "runnerUp": self.runner_up,
            "confidence": self.confidence,
            "margin": self.margin,
            "unsupported": self.unsupported,
            "samples": [sample.as_dict() for sample in self.samples],
            "probeModelId": self.probe_model_id,
            "probeModelRevision": self.probe_model_revision,
            "hint": self.hint,
            "detail": self.detail,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> LanguageDecision:
        return cls(
            state=str(payload.get("state") or ""),
            language=str(payload.get("language") or ""),
            force=str(payload.get("force") or ""),
            top=str(payload.get("top") or ""),
            runner_up=str(payload.get("runnerUp") or ""),
            confidence=float(payload.get("confidence") or 0.0),
            margin=float(payload.get("margin") or 0.0),
            unsupported=float(payload.get("unsupported") or 0.0),
            samples=tuple(Sample.from_dict(item) for item in payload.get("samples") or []),
            probe_model_id=str(payload.get("probeModelId") or ""),
            probe_model_revision=str(payload.get("probeModelRevision") or ""),
            hint=str(payload.get("hint") or ""),
            detail=str(payload.get("detail") or ""),
        )

    @classmethod
    def from_hint(cls, hint: str) -> LanguageDecision:
        """The decision an operator's ASR_LANGUAGE produces without a probe."""
        code = code_for(hint) or ""
        return cls(
            state="hint",
            language=code,
            force=code,
            top=code,
            runner_up="",
            confidence=1.0,
            margin=1.0,
            unsupported=0.0,
            samples=(),
            probe_model_id="",
            probe_model_revision="",
            hint=hint,
            detail="",
        )

    @classmethod
    def failed(cls, detail: str, hint: str = "") -> LanguageDecision:
        """The decision to record when the probe did not run or did not finish."""
        return cls(
            state="probe-failed",
            language="",
            force="",
            top="",
            runner_up="",
            confidence=0.0,
            margin=0.0,
            unsupported=0.0,
            samples=(),
            probe_model_id="",
            probe_model_revision="",
            hint=hint,
            detail=detail,
        )


def decide(
    samples: Iterable[Sample],
    *,
    min_confidence: float,
    min_margin: float,
    probe_model_id: str,
    probe_model_revision: str,
) -> LanguageDecision:
    """Settle the spoken language from the probed windows.

    Unsupported mass is checked before the thresholds, because Whisper has no
    silence class and can be confident about music, which must read as
    unsupported rather than as an uncertain language.
    """
    measured = tuple(samples)
    if not measured:
        return LanguageDecision(
            state="probe-failed",
            language="",
            force="",
            top="",
            runner_up="",
            confidence=0.0,
            margin=0.0,
            unsupported=0.0,
            samples=(),
            probe_model_id=probe_model_id,
            probe_model_revision=probe_model_revision,
            hint="",
            detail="the probe produced no samples",
        )

    count = len(measured)
    totals: dict[str, float] = {}
    outside = 0.0
    for sample in measured:
        for code, value in sample.probabilities.items():
            totals[code] = totals.get(code, 0.0) + value
        outside += sample.unsupported
    means = {code: total / count for code, total in totals.items()}
    unsupported = outside / count

    # Ties break alphabetically so the same samples always decide alike.
    ranking = sorted(means.items(), key=lambda item: (-item[1], item[0]))
    top, confidence = ranking[0] if ranking else ("", 0.0)
    runner_up, runner_up_mean = ranking[1] if len(ranking) > 1 else ("", 0.0)
    evidence = {
        "runner_up": runner_up,
        "confidence": confidence,
        "margin": confidence - runner_up_mean,
        "unsupported": unsupported,
        "samples": measured,
        "probe_model_id": probe_model_id,
        "probe_model_revision": probe_model_revision,
        "hint": "",
    }

    if unsupported >= confidence:
        return LanguageDecision(
            state="unsupported", language="", force="", top=top, detail="", **evidence
        )
    if confidence < min_confidence or evidence["margin"] < min_margin:
        return LanguageDecision(
            state="uncertain", language="", force=top, top=top, detail="", **evidence
        )
    return LanguageDecision(
        state="accepted", language=top, force=top, top=top, detail="", **evidence
    )


def resolve_align_language(decision: LanguageDecision, chunks: Iterable[dict[str, Any]]) -> str:
    """The language the aligner is told to use. It never returns "".

    A wrong language costs timing, not text, so an uncertain top is good enough
    here. With no candidate at all the script of the transcript is the best
    remaining evidence.
    """
    if decision.force:
        return decision.force
    text = " ".join(str(chunk.get("text") or "") for chunk in chunks)
    return detect_script(text) or "en"
