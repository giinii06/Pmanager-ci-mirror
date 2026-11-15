from __future__ import annotations

from asr_worker.language import (
    code_for,
    detect_language,
    detect_script,
    language_hint,
    spoken_language,
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


def test_the_script_names_a_language() -> None:
    assert detect_script("안녕하세요. 오늘은 날씨가 좋네요.") == "ko"
    assert detect_script("これはテストです。") == "ja"
    assert detect_script("这是一个测试。") == "zh"
    assert detect_script("Привет, как дела?") == "ru"
    assert detect_script("สวัสดีครับ") == "th"
    assert detect_script("12345 !!!") is None


def test_latin_is_left_to_the_caller() -> None:
    assert detect_script("People who got rich by accident.") is None


def test_the_model_answer_wins_over_the_script() -> None:
    chunks = [{"language": "Korean", "text": "hello"}]
    assert spoken_language(chunks) == "ko"


def test_a_fine_tune_that_names_nothing_falls_back_to_the_script() -> None:
    chunks = [{"language": "", "text": "People who got rich by accident."}]
    assert spoken_language(chunks) == "en"
    assert spoken_language([{"language": "", "text": "우연히 부자가 된 사람들."}]) == "ko"
    # A Korean line with an English name in it is still Korean.
    assert spoken_language([{"language": "", "text": "AI 때문에 부자가 됐다."}]) == "ko"


def test_latin_text_takes_the_operator_hint() -> None:
    chunks = [{"language": "", "text": "La gente se hizo rica por accidente."}]
    assert spoken_language(chunks, "es") == "es"
    assert spoken_language(chunks, "Spanish") == "es"


def test_no_letters_at_all_means_no_speech() -> None:
    assert spoken_language([{"language": "", "text": "♪ ♪ 123"}]) is None
    assert spoken_language([]) is None
