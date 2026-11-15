from __future__ import annotations

from asr_worker.subtitles import (
    Segment,
    build_segments,
    srt_timestamp,
    to_srt,
    to_txt,
    to_vtt,
    vtt_timestamp,
)


def chunk(words: list[tuple[str, int, int]], start: int = 0, end: int = 30_000) -> dict:
    return {
        "status": "aligned",
        "start_ms": start,
        "end_ms": end,
        "words": [{"text": text, "start_ms": a, "end_ms": b} for text, a, b in words],
    }


def test_timestamps_format_hours_minutes_and_millis() -> None:
    assert vtt_timestamp(0) == "00:00:00.000"
    assert vtt_timestamp(3_723_456) == "01:02:03.456"
    assert srt_timestamp(3_723_456) == "01:02:03,456"


def test_words_become_one_line_per_sentence() -> None:
    segments = build_segments(
        [
            chunk(
                [
                    ("안녕하세요.", 0, 900),
                    (" 오늘은", 1_000, 1_400),
                    (" 테스트입니다.", 1_500, 2_400),
                ]
            )
        ]
    )
    assert [segment.text for segment in segments] == ["안녕하세요.", "오늘은 테스트입니다."]
    assert segments[0].start_ms == 0
    assert segments[1].end_ms == 2_400


def test_long_pause_splits_a_line() -> None:
    segments = build_segments([chunk([("하나", 0, 500), (" 둘", 3_000, 3_500)])])
    assert [segment.text for segment in segments] == ["하나", "둘"]


def test_long_line_splits_on_character_budget() -> None:
    words = [
        (f"단어{i:02d}" if i == 0 else f" 단어{i:02d}", i * 300, i * 300 + 250)
        for i in range(20)
    ]
    segments = build_segments([chunk(words)], max_chars=20)
    assert len(segments) > 1
    assert all(len(segment.text) <= 24 for segment in segments)


def test_failed_alignment_contributes_no_cue() -> None:
    segments = build_segments(
        [
            {"status": "align_failed", "start_ms": 0, "end_ms": 10_000, "words": [], "text": "버려짐"},
            chunk([("남음", 10_000, 11_000)], start=10_000, end=20_000),
        ]
    )
    assert [segment.text for segment in segments] == ["남음"]


def test_vtt_and_srt_are_well_formed() -> None:
    segments = [Segment(1_000, 2_500, "첫 줄"), Segment(3_000, 4_000, "둘째 줄")]

    vtt = to_vtt(segments)
    assert vtt.startswith("WEBVTT\n")
    assert "00:00:01.000 --> 00:00:02.500" in vtt
    assert "첫 줄" in vtt

    srt = to_srt(segments)
    assert srt.startswith("1\n00:00:01,000 --> 00:00:02,500\n첫 줄")
    assert "2\n00:00:03,000 --> 00:00:04,000\n둘째 줄" in srt


def test_txt_joins_lines() -> None:
    assert to_txt([Segment(0, 100, "가"), Segment(100, 200, "나")]) == "가\n나"
