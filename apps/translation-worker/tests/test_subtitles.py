from __future__ import annotations

from translation_worker.subtitles import (
    Cue,
    cues_from_segments,
    srt_timestamp,
    to_srt,
    to_txt,
    to_vtt,
    vtt_timestamp,
)


def parse_vtt_time(value: str) -> int:
    hours, minutes, rest = value.split(":")
    seconds, millis = rest.split(".")
    return int(hours) * 3_600_000 + int(minutes) * 60_000 + int(seconds) * 1_000 + int(millis)


def cue_times(vtt: str) -> list[tuple[int, int]]:
    times: list[tuple[int, int]] = []
    for line in vtt.splitlines():
        if " --> " not in line:
            continue
        start, end = line.split(" --> ")
        times.append((parse_vtt_time(start), parse_vtt_time(end)))
    return times


def test_source_segments_keep_seq_and_timings() -> None:
    cues = cues_from_segments(
        [
            {"seq": 0, "startMs": 0, "endMs": 1_200, "text": "こんにちは"},
            {"seq": 1, "startMs": 1_500, "endMs": 3_000, "text": "元気ですか"},
        ]
    )
    assert cues == [
        Cue(seq=0, start_ms=0, end_ms=1_200, text="こんにちは"),
        Cue(seq=1, start_ms=1_500, end_ms=3_000, text="元気ですか"),
    ]


def test_cue_payload_uses_the_api_field_names() -> None:
    payload = Cue(seq=7, start_ms=10, end_ms=20, text="안녕").as_payload()
    assert payload == {"seq": 7, "startMs": 10, "endMs": 20, "text": "안녕"}


def test_timestamps_format_hours_minutes_and_millis() -> None:
    assert vtt_timestamp(0) == "00:00:00.000"
    assert vtt_timestamp(3_723_456) == "01:02:03.456"
    assert srt_timestamp(3_723_456) == "01:02:03,456"


def test_vtt_holds_each_line_until_the_next_cue_starts() -> None:
    cues = [
        Cue(seq=0, start_ms=0, end_ms=1_000, text="첫 줄"),
        Cue(seq=1, start_ms=2_000, end_ms=3_000, text="둘째 줄"),
        Cue(seq=2, start_ms=5_000, end_ms=6_000, text="셋째 줄"),
    ]
    assert cue_times(to_vtt(cues)) == [(0, 2_000), (2_000, 5_000), (5_000, 6_000)]


def test_vtt_does_not_shorten_an_overlapping_cue() -> None:
    cues = [
        Cue(seq=0, start_ms=0, end_ms=3_000, text="긴 줄"),
        Cue(seq=1, start_ms=1_000, end_ms=2_000, text="겹친 줄"),
    ]
    assert cue_times(to_vtt(cues)) == [(0, 3_000), (1_000, 2_000)]


def test_srt_keeps_the_cue_end() -> None:
    cues = [
        Cue(seq=0, start_ms=0, end_ms=1_000, text="첫 줄"),
        Cue(seq=1, start_ms=2_000, end_ms=3_000, text="둘째 줄"),
    ]
    srt = to_srt(cues)
    assert srt.startswith("1\n00:00:00,000 --> 00:00:01,000\n첫 줄")
    assert "2\n00:00:02,000 --> 00:00:03,000\n둘째 줄" in srt


def test_txt_joins_lines_in_order() -> None:
    cues = [
        Cue(seq=0, start_ms=0, end_ms=100, text="가"),
        Cue(seq=1, start_ms=100, end_ms=200, text="나"),
    ]
    assert to_txt(cues) == "가\n나"
