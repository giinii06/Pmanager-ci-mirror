from __future__ import annotations

from asr_worker.language import code_for, detect_language, language_hint


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


def test_detection_takes_the_majority_and_ignores_silence() -> None:
    chunks = [
        {"language": "English", "text": "hello"},
        {"language": "", "text": ""},
        {"language": "English", "text": "world"},
        {"language": "Korean", "text": "안녕"},
    ]
    assert detect_language(chunks) == "en"


def test_a_mixed_chunk_counts_every_language_it_names() -> None:
    chunks = [{"language": "Chinese,English"}, {"language": "English"}]
    assert detect_language(chunks) == "en"


def test_silence_detects_nothing() -> None:
    assert detect_language([{"language": "", "text": ""}]) is None
    assert detect_language([]) is None


def test_unknown_reported_languages_are_ignored() -> None:
    assert code_for("Klingon") is None
    assert code_for("") is None
    assert code_for("Korean") == "ko"
