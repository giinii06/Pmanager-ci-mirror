from __future__ import annotations

import json

import pytest

from translation_worker.subtitles import Cue
from translation_worker.translate import (
    TranslationError,
    Translator,
    build_prompt,
    parse_translations,
)


def cues(count: int, first_seq: int = 0) -> list[Cue]:
    return [
        Cue(
            seq=first_seq + index,
            start_ms=index * 1_000,
            end_ms=index * 1_000 + 800,
            text=f"원문{index}",
        )
        for index in range(count)
    ]


def batch_from(prompt: str) -> list[dict]:
    block = prompt.split("【源文】")[1].strip().splitlines()[0]
    return json.loads(block)


def answer(prompt: str, prefix: str = "번역") -> str:
    return json.dumps(
        [{"id": cue["id"], "text": f"{prefix}:{cue['text']}"} for cue in batch_from(prompt)],
        ensure_ascii=False,
    )


def test_bare_json_array_is_accepted() -> None:
    assert parse_translations('[{"id": 0, "text": "안녕"}]', [0]) == {0: "안녕"}


def test_fenced_block_is_accepted() -> None:
    raw = '```json\n[{"id": 3, "text": "안녕"}]\n```'
    assert parse_translations(raw, [3]) == {3: "안녕"}


def test_object_with_a_translations_list_is_accepted() -> None:
    raw = '{"translations": [{"id": 1, "text": "안녕"}]}'
    assert parse_translations(raw, [1]) == {1: "안녕"}


def test_prose_around_the_array_is_ignored() -> None:
    raw = '翻译结果如下：\n[{"id": 2, "text": "안녕"}]\n希望有帮助。'
    assert parse_translations(raw, [2]) == {2: "안녕"}


def test_ids_may_arrive_as_strings() -> None:
    assert parse_translations('[{"id": "4", "text": "안녕"}]', [4]) == {4: "안녕"}


def test_a_newline_inside_a_line_is_collapsed() -> None:
    raw = '[{"id": 0, "text": "첫 줄\\n둘째 줄"}]'
    assert parse_translations(raw, [0]) == {0: "첫 줄 둘째 줄"}


def test_swapped_closing_tokens_are_repaired() -> None:
    raw = '[{"id": 31, "text": "I run every day."]}'
    assert parse_translations(raw, [31]) == {31: "I run every day."}


def test_a_stray_quote_after_the_id_is_repaired() -> None:
    raw = '[{"id": 17", "text": "Um, excuse me, but is this a bad time?"}]'
    assert parse_translations(raw, [16]) == {
        16: "Um, excuse me, but is this a bad time?"
    }


def test_the_only_id_in_a_single_cue_answer_is_remapped_to_the_expected_one() -> None:
    assert parse_translations('[{"id": 17, "text": "Um, excuse me"}]', [16]) == {
        16: "Um, excuse me"
    }


def test_shifted_ids_in_a_multi_cue_answer_are_still_rejected() -> None:
    raw = '[{"id": 17, "text": "가"}, {"id": 18, "text": "나"}]'
    with pytest.raises(TranslationError):
        parse_translations(raw, [16, 17])


@pytest.mark.parametrize(
    "raw, expected",
    [
        ('[{"id": 0, "text": "가"}]', [0, 1]),
        ('[{"id": 0, "text": "가"}, {"id": 1, "text": "나"}, {"id": 2, "text": "다"}]', [0, 1]),
        ('[{"id": 0, "text": "가"}, {"id": 0, "text": "나"}]', [0]),
        ('[{"id": 0, "text": "  "}]', [0]),
        ("抱歉，我不能翻译。", [0]),
    ],
)
def test_unusable_answers_are_rejected(raw: str, expected: list[int]) -> None:
    with pytest.raises(TranslationError):
        parse_translations(raw, expected)


def test_prompt_carries_the_cue_ids_and_the_target_language() -> None:
    prompt = build_prompt(cues(2, first_seq=5), [], "ko")
    assert batch_from(prompt) == [
        {"id": 5, "text": "원문0"},
        {"id": 6, "text": "원문1"},
    ]
    assert "韩语" in prompt
    assert "只输出 JSON 数组" in prompt


def test_prompt_marks_the_previous_batch_as_reference() -> None:
    prompt = build_prompt(cues(2, first_seq=2), [("원문0", "번역:원문0")], "ko")
    assert "不要翻译" in prompt
    assert "原文：원문0" in prompt
    assert "译文：번역:원문0" in prompt


def test_every_cue_comes_back_with_its_own_timings() -> None:
    source = cues(5, first_seq=5)
    seen: list[tuple[int, int]] = []
    translator = Translator(
        lambda prompt: answer(prompt),
        batch_size=2,
        target_language="ko",
        on_batch=lambda done, total: seen.append((done, total)),
    )

    translated = translator.run(source)

    assert [(cue.seq, cue.start_ms, cue.end_ms) for cue in translated] == [
        (cue.seq, cue.start_ms, cue.end_ms) for cue in source
    ]
    assert [cue.text for cue in translated] == [f"번역:원문{index}" for index in range(5)]
    assert seen == [(1, 3), (2, 3), (3, 3)]


def test_the_second_batch_sees_the_first_one_as_reference() -> None:
    prompts: list[str] = []

    def chat(prompt: str) -> str:
        prompts.append(prompt)
        return answer(prompt)

    Translator(chat, batch_size=2, target_language="ko").run(cues(4))

    assert len(prompts) == 2
    assert "原文：" not in prompts[0]
    assert "原文：원문0" in prompts[1]
    assert "译文：번역:원문0" in prompts[1]


def test_a_failed_batch_is_split_until_each_cue_succeeds() -> None:
    sizes: list[int] = []

    def chat(prompt: str) -> str:
        batch = batch_from(prompt)
        sizes.append(len(batch))
        if len(batch) > 1:
            return "抱歉，我不能翻译。"
        answer = [{"id": batch[0]["id"], "text": f"번역:{batch[0]['text']}"}]
        return json.dumps(answer, ensure_ascii=False)

    translated = Translator(chat, batch_size=4, target_language="ko").run(cues(4))

    assert sizes == [4, 2, 1, 1, 2, 1, 1]
    assert [cue.text for cue in translated] == [f"번역:원문{index}" for index in range(4)]


def test_one_cue_that_still_fails_stops_the_job() -> None:
    translator = Translator(
        lambda prompt: "抱歉，我不能翻译。", batch_size=4, target_language="ko"
    )
    with pytest.raises(TranslationError, match="cue 0"):
        translator.run(cues(3))
