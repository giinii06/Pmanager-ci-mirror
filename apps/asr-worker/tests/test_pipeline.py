from __future__ import annotations

import json
import types
from pathlib import Path

from asr_worker.pipeline import Pipeline, safe_segment


class RecordingClient:
    def __init__(self) -> None:
        self.completions: list[dict] = []

    def complete(self, job_id: str, owner: str, payload: dict) -> dict:
        self.completions.append({"jobId": job_id, "owner": owner, **payload})
        return {}


def make_pipeline(client: RecordingClient, tmp_path) -> Pipeline:
    config = types.SimpleNamespace(
        worker_id="asr-test",
        lease_ms=120_000,
        gpu_wait_seconds=1.0,
        temp_dir=str(tmp_path),
        model_id="Qwen/Qwen3-ASR-1.7B",
        model_revision="asr-rev-1",
        aligner_id="Qwen/Qwen3-ForcedAligner-0.6B",
        aligner_revision="aligner-rev-1",
        pipeline_version="pipeline-1",
        result_dir=str(tmp_path / "results"),
    )
    return Pipeline(config, client)  # type: ignore[arg-type]


def test_a_file_with_no_speech_writes_a_transcript_and_completes(tmp_path):
    client = RecordingClient()
    pipeline = make_pipeline(client, tmp_path)

    pipeline._write_no_speech("job1", 90_000, 3, "asset1")

    relative = f"{safe_segment('asset1', 32)}/3/asr-rev-1_aligner-rev-1_pipeline-1"
    target = Path(tmp_path / "results") / relative
    transcript = json.loads((target / "transcript.json").read_text(encoding="utf-8"))
    assert transcript["hasSpeech"] is False
    assert transcript["language"] == ""
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
