from __future__ import annotations

import json
import re
from dataclasses import replace
from typing import Callable, Iterable

from .subtitles import Cue

FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)
LIST_KEYS = ("translations", "items", "segments")

LANGUAGE_NAMES = {
    "ko": "韩语",
    "en": "英语",
    "ja": "日语",
    "zh": "中文",
    "es": "西班牙语",
    "fr": "法语",
    "de": "德语",
    "ru": "俄语",
    "it": "意大利语",
    "pt": "葡萄牙语",
    "vi": "越南语",
    "th": "泰语",
    "id": "印尼语",
    "ar": "阿拉伯语",
    "hi": "印地语",
}


class TranslationError(RuntimeError):
    """The model's answer could not be used for this batch."""


def language_name(tag: str) -> str:
    return LANGUAGE_NAMES.get(tag.strip().lower().split("-")[0], tag)


def build_prompt(
    batch: Iterable[Cue],
    reference: Iterable[tuple[str, str]],
    target_language: str,
) -> str:
    """The instTrans shape the Index-Translate card documents: 源文, then
    numbered 硬性要求 and 注意 blocks, with the answer format in the constraints."""
    target = language_name(target_language)
    cues = json.dumps(
        [{"id": cue.seq, "text": cue.text} for cue in batch],
        ensure_ascii=False,
    )
    parts = [
        f"请将以下文本翻译为{target}，直接输出翻译结果，不要进行任何解释。",
        "",
        "【源文】",
        cues,
        "",
        "1. 【硬性要求】",
        "逐条翻译，id 必须与原文一一对应，不能增加、删除、合并或重排。",
        '只输出 JSON 数组，元素为 {"id": <id>, "text": "<译文>"}，'
        "不要输出解释，不要使用 Markdown 代码块。",
        "不要添加原文没有的信息，不要漏译。",
        "2. 【注意】",
        f"译文自然、口语化，符合{target}的日常说法。",
    ]
    reference = list(reference)
    if reference:
        parts += ["", "【上一批字幕，仅供理解上下文，不要翻译，也不要输出】"]
        for source, translated in reference:
            parts.append(f"原文：{source}")
            parts.append(f"译文：{translated}")
    return "\n".join(parts)


def _candidates(raw: str) -> Iterable[str]:
    text = raw.strip()
    fenced = FENCE.search(text)
    if fenced:
        yield fenced.group(1).strip()
    yield text
    starts = [index for index in (text.find("["), text.find("{")) if index >= 0]
    if starts:
        end = max(text.rfind("]"), text.rfind("}"))
        if end > min(starts):
            yield text[min(starts) : end + 1]


def _items(payload: object) -> list[object]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in LIST_KEYS:
            value = payload.get(key)
            if isinstance(value, list):
                return value
    return []


def parse_translations(raw: str, expected: list[int]) -> dict[int, str]:
    """Map cue id to translated text, or raise when the answer is unusable."""
    items: list[object] = []
    for candidate in _candidates(raw):
        try:
            payload = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        items = _items(payload)
        if items:
            break
    if not items:
        raise TranslationError(f"No JSON array of translations in the answer: {raw[:200]!r}")

    mapping: dict[int, str] = {}
    for item in items:
        if not isinstance(item, dict) or "id" not in item or "text" not in item:
            raise TranslationError(f"Item is not an id/text pair: {item!r}")
        try:
            cue_id = int(str(item["id"]).strip())
        except ValueError as error:
            raise TranslationError(f"Item id is not a number: {item['id']!r}") from error
        # A newline inside a cue would break the VTT and SRT block structure.
        text = " ".join(str(item["text"]).split())
        if not text:
            raise TranslationError(f"Empty translation for cue {cue_id}.")
        if cue_id in mapping:
            raise TranslationError(f"Cue {cue_id} appears twice.")
        mapping[cue_id] = text

    if set(mapping) != set(expected):
        missing = sorted(set(expected) - set(mapping))
        extra = sorted(set(mapping) - set(expected))
        raise TranslationError(f"Cue ids do not match the batch: missing {missing}, extra {extra}.")
    return mapping


class Translator:
    """Translates cues in batches through an injected chat callable."""

    def __init__(
        self,
        chat: Callable[[str], str],
        batch_size: int = 8,
        target_language: str = "ko",
        on_batch: Callable[[int, int], None] | None = None,
    ):
        self.chat = chat
        self.batch_size = max(1, batch_size)
        self.target_language = target_language
        self.on_batch = on_batch

    def run(self, cues: list[Cue]) -> list[Cue]:
        batches = [
            cues[index : index + self.batch_size]
            for index in range(0, len(cues), self.batch_size)
        ]
        translated: list[Cue] = []
        reference: list[tuple[str, str]] = []
        for index, batch in enumerate(batches):
            output = self._translate_batch(batch, reference)
            translated += output
            reference = [(cue.text, out.text) for cue, out in zip(batch, output)]
            if self.on_batch:
                self.on_batch(index + 1, len(batches))
        return translated

    def _translate_batch(
        self, batch: list[Cue], reference: list[tuple[str, str]]
    ) -> list[Cue]:
        try:
            raw = self.chat(build_prompt(batch, reference, self.target_language))
            mapping = parse_translations(raw, [cue.seq for cue in batch])
        except TranslationError as error:
            if len(batch) == 1:
                raise TranslationError(
                    f"The model returned no usable translation for cue {batch[0].seq}."
                ) from error
            middle = len(batch) // 2
            return self._translate_batch(batch[:middle], reference) + self._translate_batch(
                batch[middle:], reference
            )
        return [replace(cue, text=mapping[cue.seq]) for cue in batch]
