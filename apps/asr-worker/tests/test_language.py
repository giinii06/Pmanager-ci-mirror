from __future__ import annotations

from typing import Any

import pytest

from asr_worker.language import (
    LanguageDecision,
    Sample,
    code_for,
    decide,
    detect_script,
    fold_whisper,
    has_speech,
    language_hint,
    resolve_align_language,
)

FIELDS: dict[str, Any] = {
    "state": "probe-failed",
    "language": "",
    "force": "",
    "top": "",
    "runner_up": "",
    "confidence": 0.0,
    "margin": 0.0,
    "unsupported": 0.0,
    "samples": (),
    "probe_model_id": "openai/whisper-small",
    "probe_model_revision": "rev-1",
    "hint": "",
    "detail": "",
}


def build(**overrides: Any) -> LanguageDecision:
    return LanguageDecision(**{**FIELDS, **overrides})


def sample(probabilities: dict[str, float], unsupported: float = 0.0, index: int = 0) -> Sample:
    return Sample(
        index=index,
        start_ms=index * 1_000,
        end_ms=index * 1_000 + 1_000,
        probabilities=probabilities,
        unsupported=unsupported,
    )


def test_a_code_becomes_the_name_the_model_accepts() -> None:
    assert language_hint("ko") == "Korean"
    assert language_hint("en-US") == "English"
    assert language_hint(" JA ") == "Japanese"


def test_a_canonical_name_passes_through() -> None:
    assert language_hint("English") == "English"
    assert language_hint("cantonese") == "Cantonese"


def test_an_empty_hint_means_detect() -> None:
    assert language_hint("") is None
    assert language_hint(None) is None


def test_an_unknown_name_is_left_for_the_model_to_reject() -> None:
    assert language_hint("Klingon") == "Klingon"


def test_unknown_reported_languages_are_ignored() -> None:
    assert code_for("Klingon") is None
    assert code_for("") is None
    assert code_for("Korean") == "ko"


def test_the_script_names_a_language() -> None:
    assert detect_script("안녕하세요. 오늘은 날씨가 좋네요.") == "ko"
    assert detect_script("これはテストです。") == "ja"
    assert detect_script("这是一个测试。") == "zh"
    assert detect_script("Привет, как дела?") == "ru"
    assert detect_script("สวัสดีครับ") == "th"
    assert detect_script("12345 !!!") is None


def test_latin_is_left_to_the_caller() -> None:
    assert detect_script("People who got rich by accident.") is None


def test_whisper_filipino_folds_onto_the_stored_code() -> None:
    supported, unsupported = fold_whisper({"tl": 0.8, "en": 0.2})

    assert supported == {"fil": 0.8, "en": 0.2}
    assert unsupported == 0.0


def test_a_language_the_library_cannot_store_becomes_unsupported_mass() -> None:
    supported, unsupported = fold_whisper({"he": 0.7, "en": 0.3})

    assert supported == {"en": 0.3}
    assert unsupported == pytest.approx(0.7)


def test_only_letters_count_as_speech() -> None:
    assert has_speech([{"text": "こんにちは"}]) is True
    assert has_speech([{"text": "♪ ♪ 123"}]) is False
    assert has_speech([]) is False


@pytest.mark.parametrize(
    "state, language, force, top",
    [
        ("accepted", "ja", "ja", "ja"),
        ("hint", "ko", "ko", "ko"),
        ("uncertain", "", "ja", "ja"),
        ("unsupported", "", "", "ja"),
        ("probe-failed", "", "", ""),
    ],
)
def test_every_legal_state_is_constructible(
    state: str, language: str, force: str, top: str
) -> None:
    assert build(state=state, language=language, force=force, top=top).state == state


@pytest.mark.parametrize(
    "fields",
    [
        {"state": "accepted", "language": "", "force": "ja", "top": "ja"},
        {"state": "accepted", "language": "ja", "force": "ko", "top": "ja"},
        {"state": "accepted", "language": "ja", "force": "ja", "top": ""},
        {"state": "hint", "language": "", "force": "", "top": ""},
        {"state": "hint", "language": "ko", "force": "ko", "top": "ja"},
        {"state": "uncertain", "language": "ja", "force": "ja", "top": "ja"},
        {"state": "uncertain", "language": "", "force": "", "top": ""},
        {"state": "unsupported", "language": "ja", "force": "", "top": "ja"},
        {"state": "probe-failed", "language": "", "force": "ja", "top": "ja"},
        {"state": "accepted", "language": "xx", "force": "xx", "top": "xx"},
        {"state": "nonsense", "language": "", "force": "", "top": ""},
    ],
)
def test_an_illegal_combination_is_not_constructible(fields: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        build(**fields)


def test_a_confident_probe_labels_the_file_and_forces_the_model() -> None:
    decision = decide(
        [sample({"ja": 0.95, "ko": 0.01}, unsupported=0.02)],
        min_confidence=0.50,
        min_margin=0.20,
        probe_model_id="openai/whisper-small",
        probe_model_revision="rev-1",
    )

    assert decision.state == "accepted"
    assert decision.language == "ja"
    assert decision.force == "ja"
    assert decision.top == "ja"
    assert decision.runner_up == "ko"
    assert decision.confidence == 0.95
    assert decision.margin == pytest.approx(0.94)


def test_a_weak_top_still_steers_the_model_but_is_not_stored() -> None:
    decision = decide(
        [sample({"ja": 0.5, "ko": 0.4}, unsupported=0.1)],
        min_confidence=0.50,
        min_margin=0.20,
        probe_model_id="openai/whisper-small",
        probe_model_revision="rev-1",
    )

    assert decision.state == "uncertain"
    assert decision.language == ""
    assert decision.force == "ja"
    assert decision.top == "ja"


def test_a_close_second_place_is_not_a_decision() -> None:
    decision = decide(
        [sample({"ja": 0.9, "ko": 0.8})],
        min_confidence=0.50,
        min_margin=0.20,
        probe_model_id="openai/whisper-small",
        probe_model_revision="rev-1",
    )

    assert decision.state == "uncertain"
    assert decision.force == "ja"
    assert decision.margin == pytest.approx(0.1)


def test_unsupported_mass_outranks_a_weak_top() -> None:
    decision = decide(
        [sample({"ja": 0.4}, unsupported=0.5)],
        min_confidence=0.50,
        min_margin=0.20,
        probe_model_id="openai/whisper-small",
        probe_model_revision="rev-1",
    )

    assert decision.state == "unsupported"
    assert decision.language == ""
    assert decision.force == ""
    assert decision.top == "ja"


def test_the_mean_divides_by_every_sample_not_only_the_scored_ones() -> None:
    decision = decide(
        [sample({"ja": 0.9}), sample({"ko": 0.1})],
        min_confidence=0.50,
        min_margin=0.20,
        probe_model_id="openai/whisper-small",
        probe_model_revision="rev-1",
    )

    assert decision.top == "ja"
    assert decision.confidence == pytest.approx(0.45)
    assert decision.state == "uncertain"


def test_no_samples_is_a_probe_failure() -> None:
    decision = decide(
        [],
        min_confidence=0.50,
        min_margin=0.20,
        probe_model_id="openai/whisper-small",
        probe_model_revision="rev-1",
    )

    assert decision.state == "probe-failed"
    assert decision.detail == "the probe produced no samples"
    assert decision.probe_model_revision == "rev-1"


def test_a_hint_skips_the_probe_and_keeps_the_raw_value() -> None:
    decision = LanguageDecision.from_hint("ko")

    assert decision.state == "hint"
    assert decision.language == "ko"
    assert decision.force == "ko"
    assert decision.top == "ko"
    assert decision.confidence == 1.0
    assert decision.samples == ()
    assert decision.hint == "ko"


def test_a_failure_records_why_and_keeps_the_hint() -> None:
    decision = LanguageDecision.failed("the model did not load", "ko")

    assert decision.state == "probe-failed"
    assert decision.language == ""
    assert decision.force == ""
    assert decision.detail == "the model did not load"
    assert decision.hint == "ko"


def test_the_aligner_gets_the_forced_language_first() -> None:
    accepted = build(state="accepted", language="ja", force="ja", top="ja")
    uncertain = build(state="uncertain", force="ja", top="ja")

    assert resolve_align_language(accepted, [{"text": "안녕하세요"}]) == "ja"
    assert resolve_align_language(uncertain, [{"text": "안녕하세요"}]) == "ja"


def test_the_aligner_falls_back_to_the_script_then_english() -> None:
    unsupported = build(state="unsupported", top="he")
    failed = LanguageDecision.failed("no samples")

    assert resolve_align_language(unsupported, [{"text": "안녕하세요"}]) == "ko"
    assert resolve_align_language(failed, [{"text": "People got rich."}]) == "en"
    assert resolve_align_language(failed, []) == "en"
