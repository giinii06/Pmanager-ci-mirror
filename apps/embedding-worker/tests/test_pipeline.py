from __future__ import annotations

import base64
import struct

import pytest

from embedding_worker import pipeline as pipeline_module
from embedding_worker.client import JobFailure, LeaseLost
from embedding_worker.config import load_config
from embedding_worker.pipeline import Heartbeat, Pipeline

# Each cue is 500 characters, so the default 1200 budget takes two per chunk.
SEGMENTS = [
    {"startMs": 0, "endMs": 1_200, "text": "바다" * 250},
    {"startMs": 2_000, "endMs": 3_000, "text": "파도" * 250},
    {"startMs": 3_500, "endMs": 4_200, "text": "노을" * 250},
]

CHUNKS = [
    f"{SEGMENTS[0]['text']} {SEGMENTS[1]['text']}",
    SEGMENTS[2]["text"],
]

DIMENSIONS = 2


def make_config(tmp_path, **env: str):
    base = {
        "EMBEDDING_WORKER_TOKEN": "token-token-token",
        "EMBEDDING_MODEL_PATH": str(tmp_path / "model.gguf"),
        "WORKER_ID": "worker-1",
        "EMBEDDING_BATCH_SIZE": "2",
    }
    base.update(env)
    return load_config(base)


def make_claim() -> dict:
    return {
        "job": {"id": "job-1", "assetId": "asset-1", "fileVersion": 3},
        "asset": {"id": "asset-1", "filename": "sunset-at-the-beach.mp4", "fileVersion": 3},
        "text": {"language": "ko", "transcriptId": "tr-1", "segments": SEGMENTS},
        "model": {
            "id": "Qwen/Qwen3-Embedding-4B-GGUF",
            "revision": "commit-sha",
            "sha256": "a" * 64,
            "pipelineVersion": "1",
            "dimensions": DIMENSIONS,
        },
    }


def decode(encoded: str) -> list[float]:
    return list(struct.unpack(f"<{len(base64.b64decode(encoded)) // 4}f", base64.b64decode(encoded)))


class FakeClient:
    def __init__(self, acquire: list[bool] | None = None):
        self.events: list[tuple[str, object]] = []
        self.acquire_results = list(acquire or [True])
        self.completed: list[dict] | None = None
        self.failed: str | None = None

    def heartbeat(self, job_id: str, owner: str) -> None:
        self.events.append(("heartbeat", job_id))

    def progress(self, job_id: str, owner: str, state: str, stage: str, progress: float) -> None:
        self.events.append(("progress", (state, stage, progress)))

    def complete(self, job_id: str, owner: str, vectors: list[dict]) -> dict:
        self.completed = vectors
        self.events.append(("complete", len(vectors)))
        return {"embedded": len(vectors)}

    def fail(self, job_id: str, owner: str, message: str) -> dict:
        self.failed = message
        self.events.append(("fail", message))
        return {"state": "failed"}

    def gpu_acquire(self, owner: str, task_kind: str, lease_ms: int) -> bool:
        self.events.append(("acquire", task_kind))
        return self.acquire_results.pop(0) if self.acquire_results else False

    def gpu_heartbeat(self, owner: str) -> None:
        self.events.append(("gpu_heartbeat", owner))

    def gpu_release(self, owner: str) -> None:
        self.events.append(("release", owner))

    def names(self) -> list[str]:
        return [name for name, _ in self.events]


class FakeServer:
    def __init__(self, client: FakeClient | None = None, on_embed=None):
        self.started = False
        self.stopped = False
        self.events = client.events if client else []
        self.on_embed = on_embed
        self.batches: list[list[str]] = []

    def start(self) -> None:
        self.started = True

    def embed(self, texts: list[str], dimensions: int) -> list[list[float]]:
        self.batches.append(list(texts))
        if self.on_embed:
            self.on_embed()
        return [[1.0] + [0.0] * (dimensions - 1) for _ in texts]

    def stop(self) -> None:
        self.stopped = True
        self.events.append(("stop", None))

    def terminate(self) -> None:
        self.events.append(("terminate", None))


def run_pipeline(config, client: FakeClient, server: FakeServer) -> None:
    heartbeat = Heartbeat(client, "job-1", "worker-1", config.lease_ms)
    Pipeline(config, client, server_factory=lambda: server).process(make_claim(), heartbeat)


def test_the_filename_stem_is_the_first_document_and_the_chunks_follow(tmp_path) -> None:
    client = FakeClient()
    server = FakeServer(client)
    run_pipeline(make_config(tmp_path), client, server)

    documents = [text for batch in server.batches for text in batch]
    assert documents[0] == "sunset-at-the-beach"
    assert documents[1:] == CHUNKS

    title = client.completed[0]
    assert title["kind"] == "title"
    assert title["text"] == "sunset-at-the-beach"
    assert title["startMs"] is None
    assert title["chunkIndex"] == 0
    assert decode(title["vector"]) == pytest.approx([1.0, 0.0])


def test_every_chunk_is_sent_with_its_span_and_a_unit_vector(tmp_path) -> None:
    client = FakeClient()
    run_pipeline(make_config(tmp_path), client, FakeServer(client))

    chunks = client.completed[1:]
    assert [chunk["kind"] for chunk in chunks] == ["chunk", "chunk"]
    assert [chunk["chunkIndex"] for chunk in chunks] == [0, 1]
    assert [chunk["text"] for chunk in chunks] == CHUNKS
    assert [(chunk["startMs"], chunk["endMs"]) for chunk in chunks] == [
        (0, 3_000),
        (3_500, 4_200),
    ]
    for chunk in chunks:
        assert decode(chunk["vector"]) == pytest.approx([1.0, 0.0])


def test_progress_runs_from_the_server_start_to_the_write(tmp_path) -> None:
    client = FakeClient()
    run_pipeline(make_config(tmp_path), client, FakeServer(client))

    progress = [payload for name, payload in client.events if name == "progress"]
    assert progress[0] == ("embedding", "starting", 2.0)
    assert ("embedding", "starting", 5.0) in progress
    assert ("embedding", "embedding", 90.0) in progress
    assert progress[-1] == ("writing", "writing", 95.0)
    assert [value for _, _, value in progress] == sorted(value for _, _, value in progress)


def test_the_gpu_is_released_only_after_the_server_is_down(tmp_path) -> None:
    client = FakeClient()
    run_pipeline(make_config(tmp_path), client, FakeServer(client))

    names = client.names()
    assert names.index("complete") < names.index("stop") < names.index("release")


def test_a_busy_gpu_fails_the_job_without_touching_the_server(tmp_path) -> None:
    client = FakeClient(acquire=[False])
    server = FakeServer(client)
    config = make_config(tmp_path, GPU_WAIT_SECONDS="0")

    with pytest.raises(JobFailure) as error:
        run_pipeline(config, client, server)

    assert str(error.value) == "GPU is busy with another job."
    assert server.started is False
    assert "release" not in client.names()
    assert client.completed is None


def test_the_gpu_is_retried_until_it_is_free(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(pipeline_module, "GPU_RETRY_SECONDS", 0.0)
    client = FakeClient(acquire=[False, False, True])
    run_pipeline(make_config(tmp_path), client, FakeServer(client))

    assert client.names().count("acquire") == 3
    assert client.completed is not None


def test_a_lost_lease_stops_the_server_and_completes_nothing(tmp_path) -> None:
    client = FakeClient()
    heartbeat = Heartbeat(client, "job-1", "worker-1", 120_000)
    server = FakeServer(client, on_embed=heartbeat.lost.set)

    with pytest.raises(LeaseLost):
        Pipeline(make_config(tmp_path), client, server_factory=lambda: server).process(
            make_claim(), heartbeat
        )

    assert client.completed is None
    assert server.stopped is True
    assert "release" in client.names()


def test_a_video_without_a_transcript_embeds_its_title_alone(tmp_path) -> None:
    client = FakeClient()
    server = FakeServer(client)
    claim = make_claim()
    claim["text"] = {"language": None, "transcriptId": None, "segments": []}

    heartbeat = Heartbeat(client, "job-1", "worker-1", 120_000)
    Pipeline(make_config(tmp_path), client, server_factory=lambda: server).process(claim, heartbeat)

    assert len(client.completed) == 1
    assert client.completed[0]["kind"] == "title"
