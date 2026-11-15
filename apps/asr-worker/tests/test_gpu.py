from __future__ import annotations

from typing import Any

import pytest

from asr_worker.client import LeaseLost, WorkerClient
from asr_worker.config import load_config
from asr_worker.pipeline import Heartbeat, Pipeline

from test_jobs import StubApi, api  # noqa: F401 - the fixture is the import


def build(api: StubApi, wait: float = 5.0) -> tuple[Pipeline, Heartbeat, WorkerClient]:
    config = load_config(
        {
            "ASR_WORKER_TOKEN": "test-token",
            "API_BASE_URL": api.base_url,
            "ASR_WORKER_ID": "worker-a",
            "ASR_LEASE_MS": "30000",
            "GPU_WAIT_SECONDS": str(wait),
        }
    )
    client = WorkerClient(api.base_url, "test-token")
    return Pipeline(config, client), Heartbeat(client, "job1", "worker-a", config.lease_ms), client


def test_gpu_calls_use_the_shared_worker_paths(api: StubApi) -> None:
    api.reply(200, {"acquired": True, "lease": {"owner": "worker-a"}})
    api.reply(204, {})
    api.reply(204, {})
    _, _, client = build(api)

    assert client.gpu_acquire("worker-a", "asr", 30_000) is True
    client.gpu_heartbeat("worker-a")
    client.gpu_release("worker-a")

    assert [path for path, _, _ in api.requests] == [
        "/worker/gpu/acquire",
        "/worker/gpu/heartbeat",
        "/worker/gpu/release",
    ]
    assert api.requests[0][1] == {"owner": "worker-a", "taskKind": "asr", "leaseMs": 30_000}
    assert all(headers["x-worker-token"] == "test-token" for _, _, headers in api.requests)


def test_a_lost_job_lease_stops_the_gpu_wait(api: StubApi) -> None:
    pipeline, heartbeat, _ = build(api)
    heartbeat.lost.set()

    with pytest.raises(LeaseLost):
        pipeline._run_stage(
            ["bogus"], heartbeat, "job1", state="transcribing", stage="transcribing", low=10, high=55
        )

    assert api.requests == []


def test_a_failed_stage_still_releases_the_card(api: StubApi) -> None:
    api.reply(200, {"acquired": True, "lease": {"owner": "worker-a"}})
    api.reply(204, {})
    pipeline, heartbeat, _ = build(api)

    with pytest.raises(RuntimeError, match="stage failed"):
        pipeline._run_stage(
            ["bogus"], heartbeat, "job1", state="transcribing", stage="transcribing", low=10, high=55
        )

    paths = [path for path, _, _ in api.requests]
    assert paths == ["/worker/gpu/acquire", "/worker/gpu/release"]
    assert not heartbeat.gpu.is_set()


def test_a_release_failure_does_not_mask_the_stage_error(api: StubApi) -> None:
    api.reply(200, {"acquired": True, "lease": {"owner": "worker-a"}})
    api.reply(500, {"error": "boom"})
    api.reply(500, {"error": "boom"})
    pipeline, heartbeat, _ = build(api)

    with pytest.raises(RuntimeError, match="stage failed"):
        pipeline._run_stage(
            ["bogus"], heartbeat, "job1", state="transcribing", stage="transcribing", low=10, high=55
        )
