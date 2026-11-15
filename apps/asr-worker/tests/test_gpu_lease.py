from __future__ import annotations

import subprocess
import types

from asr_worker.pipeline import Heartbeat, Pipeline


class RecordingClient:
    def __init__(self, acquired: bool = True):
        self.events: list[str] = []
        self.acquired = acquired

    def progress(self, *args) -> None:
        pass

    def heartbeat(self, job_id: str, owner: str) -> None:
        self.events.append("job-heartbeat")

    def gpu_acquire(self, owner: str, task_kind: str, lease_ms: int) -> bool:
        self.events.append(f"acquire:{task_kind}")
        return self.acquired

    def gpu_heartbeat(self, owner: str) -> None:
        self.events.append("gpu-heartbeat")

    def gpu_release(self, owner: str) -> None:
        self.events.append("release")


class FakeProcess:
    def __init__(self, *args, **kwargs):
        self.stdout = iter(["PROGRESS 0.5\n"])
        self.returncode = 0

    def wait(self, timeout=None) -> int:
        return self.returncode

    def poll(self):
        return self.returncode

    def terminate(self) -> None:
        pass

    def kill(self) -> None:
        pass


def make_pipeline(client: RecordingClient) -> Pipeline:
    config = types.SimpleNamespace(
        worker_id="asr-test",
        lease_ms=120_000,
        gpu_wait_seconds=1.0,
    )
    return Pipeline(config, client)  # type: ignore[arg-type]


def test_stage_holds_the_gpu_lease_for_the_process(monkeypatch):
    client = RecordingClient()
    events = client.events

    def popen(*args, **kwargs):
        events.append("start")
        return FakeProcess()

    monkeypatch.setattr(subprocess, "Popen", popen)
    pipeline = make_pipeline(client)
    heartbeat = Heartbeat(client, "job1", "asr-test", 120_000)  # type: ignore[arg-type]

    pipeline._run_stage(
        ["transcribe"],
        heartbeat,
        "job1",
        state="transcribing",
        stage="transcribing",
        low=0,
        high=100,
    )

    assert events == ["acquire:asr", "start", "release"]


def test_a_busy_gpu_starts_no_process(monkeypatch):
    client = RecordingClient(acquired=False)
    started = []

    def popen(*args, **kwargs):
        started.append(True)
        return FakeProcess()

    monkeypatch.setattr(subprocess, "Popen", popen)
    pipeline = make_pipeline(client)
    heartbeat = Heartbeat(client, "job1", "asr-test", 120_000)  # type: ignore[arg-type]

    try:
        pipeline._run_stage(
            ["transcribe"],
            heartbeat,
            "job1",
            state="transcribing",
            stage="transcribing",
            low=0,
            high=100,
        )
    except RuntimeError as error:
        assert "GPU is busy" in str(error)
    else:
        raise AssertionError("a busy GPU must fail the stage")

    assert started == []
    assert "release" not in client.events
