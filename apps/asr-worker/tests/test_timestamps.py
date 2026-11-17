from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from asr_worker import align
from asr_worker.audio import plan_chunks
from asr_worker.timeline import MAX_INVERSION_MS, attach_source_text, clean_words


def word(text: str, start: float, end: float) -> SimpleNamespace:
    return SimpleNamespace(text=text, start_time=start, end_time=end)


def test_short_audio_is_one_chunk() -> None:
    assert plan_chunks(20_000, []) == [(0, 20_000)]


def test_chunks_cut_on_a_silence_midpoint() -> None:
    silences = [(18_000, 20_000)]
    chunks = plan_chunks(45_000, silences, min_ms=15_000, max_ms=30_000)
    assert chunks[0] == (0, 19_000)
    assert chunks[1] == (19_000, 45_000)


def test_chunks_cover_the_whole_file_without_gaps() -> None:
    chunks = plan_chunks(97_640, [(20_000, 21_000), (44_000, 45_000), (70_000, 71_000)])
    assert chunks[0][0] == 0
    assert chunks[-1][1] == 97_640
    for previous, following in zip(chunks, chunks[1:]):
        assert previous[1] == following[0]


def test_hard_cut_when_there_is_no_pause() -> None:
    chunks = plan_chunks(70_000, [], min_ms=15_000, max_ms=30_000)
    assert chunks == [(0, 30_000), (30_000, 60_000), (60_000, 70_000)]


def test_short_tail_is_merged_into_the_previous_chunk() -> None:
    chunks = plan_chunks(31_000, [], min_ms=15_000, max_ms=30_000)
    assert chunks == [(0, 31_000)]


def test_words_get_the_chunk_offset() -> None:
    words, problem = clean_words([word("안녕", 0.5, 0.9), word("하세요", 1.0, 1.4)], 20_000, 50_000)
    assert problem is None
    assert words == [
        {"text": "안녕", "start_ms": 20_500, "end_ms": 20_900},
        {"text": "하세요", "start_ms": 21_000, "end_ms": 21_400},
    ]


def test_words_are_clamped_to_the_chunk_window() -> None:
    words, problem = clean_words([word("끝", 29.0, 40.0)], 0, 30_000)
    assert problem is None
    assert words[0]["end_ms"] == 30_000


def test_zero_length_words_are_dropped() -> None:
    words, problem = clean_words([word("x", 1.0, 1.0), word("y", 2.0, 2.5)], 0, 30_000)
    assert problem is None
    assert [entry["text"] for entry in words] == ["y"]


def test_small_overlap_is_nudged_forward() -> None:
    words, problem = clean_words([word("a", 1.0, 2.0), word("b", 1.9, 2.4)], 0, 30_000)
    assert problem is None
    assert words[1]["start_ms"] == 2_000


def test_large_overlap_is_reported_instead_of_guessed() -> None:
    late = MAX_INVERSION_MS + 500
    words, problem = clean_words(
        [word("a", 1.0, 2.0), word("b", 2.0 - late / 1000, 2.2)],
        0,
        30_000,
    )
    assert words == []
    assert problem == "non-monotonic timestamps"


def test_source_text_keeps_korean_spacing_and_punctuation() -> None:
    words = [
        {"text": "고릴라", "start_ms": 0, "end_ms": 100},
        {"text": "가", "start_ms": 100, "end_ms": 200},
        {"text": "아니", "start_ms": 200, "end_ms": 300},
        {"text": "세요", "start_ms": 300, "end_ms": 400},
    ]
    attach_source_text(words, "고릴라가 아니세요?")
    assert [word["text"] for word in words] == ["고릴라", "가", " 아니", "세요"]
    assert "".join(word["text"] for word in words) == "고릴라가 아니세요"


def test_source_text_falls_back_when_a_token_was_normalized() -> None:
    words = [{"text": "없는말", "start_ms": 0, "end_ms": 100}]
    attach_source_text(words, "다른 문장")
    assert words[0]["text"] == "없는말"


def test_punctuation_stays_with_the_sentence_it_ends() -> None:
    words = [
        {"text": "안", "start_ms": 0, "end_ms": 100},
        {"text": "돼요", "start_ms": 100, "end_ms": 200},
        {"text": "제가", "start_ms": 200, "end_ms": 300},
    ]
    attach_source_text(words, "안 돼요? 제가")
    assert [word["text"] for word in words] == ["안", " 돼요?", " 제가"]


def test_punctuation_without_a_space_moves_to_the_previous_word() -> None:
    words = [
        {"text": "끝", "start_ms": 0, "end_ms": 100},
        {"text": "다음", "start_ms": 100, "end_ms": 200},
    ]
    attach_source_text(words, "끝.다음")
    assert [word["text"] for word in words] == ["끝.", "다음"]


class StubAligner:
    def __init__(self, responses: dict[str, list[list[SimpleNamespace]] | Exception]) -> None:
        self.responses = responses

    def align(self, *, audio: str, text: str, language: str) -> list[list[SimpleNamespace]]:
        outcome = self.responses[audio]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def _run_align_with_stub(
    monkeypatch,
    tmp_path: Path,
    chunks: list[dict[str, Any]],
    responses: dict[str, list[list[SimpleNamespace]] | Exception],
) -> tuple[dict[str, Any], Path]:
    asr_path = tmp_path / "asr.json"
    output_path = tmp_path / "aligned.json"
    asr_path.write_text(json.dumps({"chunks": chunks}), encoding="utf-8")
    monkeypatch.setattr(align, "load_model", lambda *args, **kwargs: StubAligner(responses))
    monkeypatch.setattr(align, "empty_cache", lambda device: None)
    result = align.run(asr_path, "/models/aligner", "cpu", "ko", output_path)
    return result, output_path


def test_align_marks_zero_duration_tokens_as_align_failed_without_raising(
    monkeypatch, tmp_path: Path
) -> None:
    result, output_path = _run_align_with_stub(
        monkeypatch,
        tmp_path,
        [
            {
                "index": 0,
                "start_ms": 0,
                "end_ms": 5000,
                "wav": "chunk-0000.wav",
                "status": "transcribed",
                "text": "음",
            }
        ],
        {"chunk-0000.wav": [[word("음", 0.0, 0.0)]]},
    )

    written = json.loads(output_path.read_text(encoding="utf-8"))
    for payload in (result, written):
        assert payload["chunks"][0]["status"] == "align_failed"
        assert payload["chunks"][0]["align_error"] == "no timestamps"
        assert payload["chunks"][0]["words"] == []


@pytest.mark.parametrize(
    ("chunks", "responses", "expected_match"),
    [
        pytest.param(
            [
                {
                    "index": 0,
                    "start_ms": 0,
                    "end_ms": 5000,
                    "wav": "chunk-0000.wav",
                    "status": "transcribed",
                    "text": "음",
                },
                {
                    "index": 1,
                    "start_ms": 5000,
                    "end_ms": 10000,
                    "wav": "chunk-0001.wav",
                    "status": "transcribed",
                    "text": "아",
                },
            ],
            {
                "chunk-0000.wav": [[word("음", 0.0, 0.0)]],
                "chunk-0001.wav": RuntimeError("CUDA out of memory"),
            },
            "CUDA out of memory",
            id="align_error",
        ),
        pytest.param(
            [
                {
                    "index": 0,
                    "start_ms": 0,
                    "end_ms": 5000,
                    "wav": "chunk-0000.wav",
                    "status": "failed",
                    "error": "RuntimeError: transcribe boom",
                    "text": "",
                },
                {
                    "index": 1,
                    "start_ms": 5000,
                    "end_ms": 10000,
                    "wav": "chunk-0001.wav",
                    "status": "transcribed",
                    "text": "음",
                },
            ],
            {"chunk-0001.wav": [[word("음", 0.0, 0.0)]]},
            "transcribe boom",
            id="transcribe_error",
        ),
    ],
)
def test_align_raises_when_an_execution_error_leaves_no_words(
    monkeypatch,
    tmp_path: Path,
    chunks: list[dict[str, Any]],
    responses: dict[str, list[list[SimpleNamespace]] | Exception],
    expected_match: str,
) -> None:
    with pytest.raises(RuntimeError, match=expected_match):
        _run_align_with_stub(monkeypatch, tmp_path, chunks, responses)
