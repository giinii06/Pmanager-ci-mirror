from __future__ import annotations

import json
import threading
import types
from pathlib import Path
from typing import Any

from asr_worker import audio
from asr_worker.language import LanguageDecision
from asr_worker.pipeline import Pipeline, safe_segment

JOB = {
    "id": "job1",
    "assetId": "asset1",
    "fileVersion": 3,
    "modelRevision": "asr-rev-1",
    "alignerRevision": "aligner-rev-1",
    "pipelineVersion": "pipeline-1",
}


class RecordingClient:
    def __init__(self) -> None:
        self.completions: list[dict] = []
        self.reports: list[tuple[str, str, float]] = []

    def complete(self, job_id: str, owner: str, payload: dict) -> dict:
        self.completions.append({"jobId": job_id, "owner": owner, **payload})
        return {}

    def progress(self, job_id: str, owner: str, state: str, stage: str, progress: float) -> None:
        self.reports.append((state, stage, progress))


class StubHeartbeat:
    def __init__(self) -> None:
        self.lost = threading.Event()


def make_pipeline(client: RecordingClient, tmp_path: Path, language: str = "") -> Pipeline:
    config = types.SimpleNamespace(
        worker_id="asr-test",
        lease_ms=120_000,
        gpu_wait_seconds=1.0,
        temp_dir=str(tmp_path),
        media_root="/media",
        model_dir="/models/asr",
        aligner_dir="/models/aligner",
        device="cpu",
        language=language,
        langid_dir="/models/langid",
        langid_samples=5,
        langid_min_confidence=0.60,
        langid_min_margin=0.15,
        min_chunk_ms=15_000,
        max_chunk_ms=30_000,
        model_id="Qwen/Qwen3-ASR-1.7B",
        model_revision="asr-rev-1",
        aligner_id="Qwen/Qwen3-ForcedAligner-0.6B",
        aligner_revision="aligner-rev-1",
        pipeline_version="pipeline-1",
        result_dir=str(tmp_path / "results"),
        keep_workdir=False,
    )
    return Pipeline(config, client)  # type: ignore[arg-type]


def decision_payload(
    state: str = "accepted", language: str = "ja", force: str = "ja", top: str = "ja"
) -> dict[str, Any]:
    return {
        "state": state,
        "language": language,
        "force": force,
        "top": top,
        "runnerUp": "ko",
        "confidence": 0.97,
        "margin": 0.95,
        "unsupported": 0.01,
        "samples": [],
        "probeModelId": "openai/whisper-small",
        "probeModelRevision": "langid-rev-1",
        "hint": "",
        "detail": "",
    }


def language_arg(args: list[str]) -> str:
    return args[args.index("--language") + 1]


def run_job(
    monkeypatch,
    tmp_path: Path,
    *,
    payload: dict[str, Any] | None = None,
    detect_error: str | None = None,
    language: str = "",
    text: str = "こんにちは。",
) -> tuple[RecordingClient, list[list[str]], dict[str, Any]]:
    client = RecordingClient()
    pipeline = make_pipeline(client, tmp_path, language)
    monkeypatch.setattr(Pipeline, "_device", lambda self: "cpu")
    monkeypatch.setattr(audio, "resolve_media", lambda root, path: tmp_path / "clip.mp4")
    monkeypatch.setattr(audio, "has_audio_stream", lambda source: True)
    monkeypatch.setattr(audio, "extract_audio", lambda source, wav: wav.write_bytes(b"wav"))
    monkeypatch.setattr(audio, "probe_duration_ms", lambda wav: 1_000)
    monkeypatch.setattr(audio, "detect_silences", lambda wav: [])
    monkeypatch.setattr(audio, "plan_chunks", lambda duration, silences, **kwargs: [(0, 1_000)])
    monkeypatch.setattr(audio, "slice_wav", lambda wav, start, end, path: path.write_bytes(b"chunk"))

    calls: list[tuple[list[str], bool]] = []

    def fake_run_stage(self, args, heartbeat, job_id, *, state, stage, low, high, gpu=True):
        calls.append((list(args), gpu))
        output = Path(args[args.index("--output") + 1])
        if args[0] == "detect":
            if detect_error is not None:
                raise RuntimeError(detect_error)
            output.write_text(json.dumps(payload), encoding="utf-8")
        elif args[0] == "transcribe":
            output.write_text(
                json.dumps(
                    {
                        "chunks": [
                            {
                                "index": 0,
                                "start_ms": 0,
                                "end_ms": 1_000,
                                "wav": "chunk-0000.wav",
                                "status": "transcribed",
                                "text": text,
                                "language": "",
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
        else:
            output.write_text(
                json.dumps(
                    {
                        "chunks": [
                            {
                                "index": 0,
                                "start_ms": 0,
                                "end_ms": 1_000,
                                "wav": "chunk-0000.wav",
                                "status": "aligned",
                                "text": text,
                                "words": [{"text": text, "start_ms": 0, "end_ms": 900}],
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )

    monkeypatch.setattr(Pipeline, "_run_stage", fake_run_stage)
    pipeline.process(JOB, {"path": "clip.mp4"}, StubHeartbeat())

    relative = f"{safe_segment('asset1', 32)}/3/asr-rev-1_aligner-rev-1_pipeline-1"
    target = Path(tmp_path / "results") / relative
    transcript = json.loads((target / "transcript.json").read_text(encoding="utf-8"))
    return client, calls, transcript


def test_an_accepted_language_is_forced_into_both_stages(monkeypatch, tmp_path):
    client, calls, transcript = run_job(monkeypatch, tmp_path, payload=decision_payload())

    assert [args[0] for args, _ in calls] == ["detect", "transcribe", "align"]
    assert [gpu for _, gpu in calls] == [False, True, True]
    assert language_arg(calls[1][0]) == "ja"
    assert language_arg(calls[2][0]) == "ja"
    assert transcript["language"] == "ja"
    assert transcript["languageDecision"]["state"] == "accepted"
    assert transcript["languageDecision"]["alignLanguage"] == "ja"
    assert client.completions[0]["language"] == "ja"


def test_an_uncertain_language_steers_the_model_but_is_not_stored(monkeypatch, tmp_path):
    payload = decision_payload(state="uncertain", language="", force="ja")
    _, calls, transcript = run_job(monkeypatch, tmp_path, payload=payload)

    assert language_arg(calls[1][0]) == "ja"
    assert language_arg(calls[2][0]) == "ja"
    assert transcript["language"] == ""
    assert transcript["languageDecision"]["state"] == "uncertain"
    assert transcript["languageDecision"]["alignLanguage"] == "ja"


def test_a_failed_probe_still_completes_the_job(monkeypatch, tmp_path):
    client, calls, transcript = run_job(monkeypatch, tmp_path, detect_error="whisper is missing")

    assert [args[0] for args, _ in calls] == ["detect", "transcribe", "align"]
    assert language_arg(calls[1][0]) == ""
    assert language_arg(calls[2][0]) == "ja"
    assert transcript["language"] == ""
    assert transcript["languageDecision"]["state"] == "probe-failed"
    assert transcript["languageDecision"]["detail"] == "RuntimeError: whisper is missing"
    assert client.completions


def test_a_hint_skips_the_probe(monkeypatch, tmp_path):
    _, calls, transcript = run_job(monkeypatch, tmp_path, language="ko")

    assert [args[0] for args, _ in calls] == ["transcribe", "align"]
    assert language_arg(calls[0][0]) == "ko"
    assert language_arg(calls[1][0]) == "ko"
    assert transcript["language"] == "ko"
    assert transcript["languageDecision"]["state"] == "hint"


def test_a_file_with_no_speech_writes_a_transcript_and_completes(tmp_path):
    client = RecordingClient()
    pipeline = make_pipeline(client, tmp_path)

    pipeline._write_no_speech("job1", 90_000, 3, "asset1", LanguageDecision.from_hint("ko"))

    relative = f"{safe_segment('asset1', 32)}/3/asr-rev-1_aligner-rev-1_pipeline-1"
    target = Path(tmp_path / "results") / relative
    transcript = json.loads((target / "transcript.json").read_text(encoding="utf-8"))
    assert transcript["hasSpeech"] is False
    assert transcript["language"] == ""
    assert transcript["languageDecision"]["state"] == "hint"
    assert transcript["segments"] == []
    assert transcript["chunks"] == []
    assert transcript["durationMs"] == 90_000
    assert not (target / "subtitles.vtt").exists()

    assert len(client.completions) == 1
    sent = client.completions[0]
    assert sent["jobId"] == "job1"
    assert sent["owner"] == "asr-test"
    assert sent["resultDir"] == relative
    assert sent["hasSpeech"] is False
    assert sent["language"] == ""
    assert sent["plainText"] == ""
    assert sent["segments"] == []
