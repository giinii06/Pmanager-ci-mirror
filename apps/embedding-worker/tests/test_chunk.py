from __future__ import annotations

from embedding_worker.chunk import plan_chunks


def segments(count: int, size: int = 10) -> list[dict]:
    return [
        {"startMs": index * 1_000, "endMs": index * 1_000 + 900, "text": str(index) * size}
        for index in range(count)
    ]


def test_chunks_respect_the_character_budget() -> None:
    chunks = plan_chunks(segments(5), max_chars=25)

    assert len(chunks) == 3
    assert [len(chunk.text) for chunk in chunks] == [21, 21, 10]
    assert all(len(chunk.text) <= 25 for chunk in chunks)


def test_a_cue_longer_than_the_budget_is_never_split() -> None:
    long_cue = [{"startMs": 0, "endMs": 4_000, "text": "가" * 40}]

    chunks = plan_chunks(long_cue, max_chars=10)

    assert len(chunks) == 1
    assert chunks[0].text == "가" * 40


def test_each_chunk_keeps_the_first_and_last_cue_timestamps() -> None:
    chunks = plan_chunks(segments(5), max_chars=25)

    assert [(chunk.index, chunk.start_ms, chunk.end_ms) for chunk in chunks] == [
        (0, 0, 1_900),
        (1, 2_000, 3_900),
        (2, 4_000, 4_900),
    ]


def test_no_segments_plan_no_chunks() -> None:
    assert plan_chunks([]) == []
