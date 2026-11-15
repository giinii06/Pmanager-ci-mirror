from __future__ import annotations

import subprocess
import sys
import time
import types
import urllib.error
from pathlib import Path

import pytest

from asr_worker import pipeline as pipeline_module
from asr_worker.client import FatalError
from asr_worker.pipeline import Heartbeat, Pipeline
from asr_worker.stage_pid import stage_pid_file


class RecordingClient:
    def __init__(self, acquired: bool = True):
        self.events: list[str] = []
        self.acquired = acquired

    def progress(self, *args) -> None:
        pass

    def heartbeat(self, job_id: str, owner: str, *, timeout: float | None = None) -> None:
        self.events.append("job-heartbeat")

    def gpu_acquire(self, owner: str, task_kind: str, lease_ms: int) -> bool:
        self.events.append(f"acquire:{task_kind}")
        return self.acquired

    def gpu_heartbeat(self, owner: str, *, timeout: float | None = None) -> None:
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


def make_pipeline(client: RecordingClient, tmp_path) -> Pipeline:
    config = types.SimpleNamespace(
        worker_id="asr-test",
        lease_ms=120_000,
        gpu_wait_seconds=1.0,
        temp_dir=str(tmp_path),
    )
    return Pipeline(config, client)  # type: ignore[arg-type]


def patch_popen(monkeypatch, popen) -> None:
    """Shim the module's `subprocess`, not the real one: `_start_of` shells out through
    `subprocess.run`, which builds its own Popen from the real module."""
    monkeypatch.setattr(
        pipeline_module,
        "subprocess",
        types.SimpleNamespace(
            Popen=popen, PIPE=subprocess.PIPE, TimeoutExpired=subprocess.TimeoutExpired
        ),
    )


def test_stage_holds_the_gpu_lease_for_the_process(monkeypatch, tmp_path):
    client = RecordingClient()
    events = client.events

    def popen(*args, **kwargs):
        events.append("start")
        return FakeProcess()

    patch_popen(monkeypatch, popen)
    pipeline = make_pipeline(client, tmp_path)
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


def test_a_busy_gpu_starts_no_process(monkeypatch, tmp_path):
    client = RecordingClient(acquired=False)
    started = []

    def popen(*args, **kwargs):
        started.append(True)
        return FakeProcess()

    patch_popen(monkeypatch, popen)
    pipeline = make_pipeline(client, tmp_path)
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


def test_the_stage_is_reaped_before_it_is_spawned(monkeypatch, tmp_path):
    client = RecordingClient()
    events = client.events
    reaped: list[Path] = []
    commands: list[list[str]] = []

    def reap(path):
        reaped.append(path)
        events.append("reap")
        return True

    def popen(command, **kwargs):
        commands.append(command)
        events.append("start")
        return FakeProcess()

    patch_popen(monkeypatch, popen)
    monkeypatch.setattr(pipeline_module, "reap_stale_stage", reap)
    pipeline = make_pipeline(client, tmp_path)
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

    assert events == ["acquire:asr", "reap", "start", "release"]
    assert reaped == [stage_pid_file(str(tmp_path))]
    assert commands == [
        [
            sys.executable,
            "-m",
            "asr_worker.stage",
            "transcribe",
            "--pid-file",
            str(stage_pid_file(str(tmp_path))),
        ]
    ]


def test_a_stage_that_still_holds_the_card_starts_no_second_model(monkeypatch, tmp_path):
    client = RecordingClient()
    started: list[list[str]] = []

    def popen(command, **kwargs):
        started.append(command)
        return FakeProcess()

    patch_popen(monkeypatch, popen)
    monkeypatch.setattr(pipeline_module, "reap_stale_stage", lambda path: False)
    pipeline = make_pipeline(client, tmp_path)
    heartbeat = Heartbeat(client, "job1", "asr-test", 120_000)  # type: ignore[arg-type]

    with pytest.raises(RuntimeError, match="still holds the card"):
        pipeline._run_stage(
            ["transcribe"],
            heartbeat,
            "job1",
            state="transcribing",
            stage="transcribing",
            low=0,
            high=100,
        )

    assert started == []
    assert "release" in client.events


class RunningProcess:
    """A stage process that is still working when the lease goes."""

    def __init__(self) -> None:
        self.terminated = False

    def poll(self):
        return None

    def terminate(self) -> None:
        self.terminated = True


class UnreachableClient(RecordingClient):
    """Every renewal fails the way a paused API fails."""

    def heartbeat(self, job_id: str, owner: str, *, timeout: float | None = None) -> None:
        raise urllib.error.URLError("API paused")


class UnauthorizedClient(RecordingClient):
    """A renewal the API refuses outright, which used to end the loop at error level."""

    def heartbeat(self, job_id: str, owner: str, *, timeout: float | None = None) -> None:
        raise FatalError("The API rejected ASR_WORKER_TOKEN.")


class SlowClient(RecordingClient):
    """A renewal that outlives its own timeout, which is what a hung socket looks like."""

    def __init__(self, lease: float):
        super().__init__()
        self.lease = lease
        self.calls: list[tuple[float | None, float]] = []

    def heartbeat(self, job_id: str, owner: str, *, timeout: float | None = None) -> None:
        self.calls.append((timeout, time.monotonic()))
        time.sleep(4 * self.lease)
        raise TimeoutError("the renewal outlived its own timeout")


def test_an_unreachable_api_loses_the_lease_and_kills_the_stage() -> None:
    """A renewal that cannot be confirmed before the lease ends means the card is gone."""
    client = UnreachableClient()
    heartbeat = Heartbeat(client, "job1", "asr-test", lease_ms=300, interval=0.05)  # type: ignore[arg-type]
    process = RunningProcess()
    heartbeat.attach(process)  # type: ignore[arg-type]

    heartbeat.start()
    try:
        assert heartbeat.lost.wait(timeout=1.0) is True
    finally:
        heartbeat.stop()

    assert process.terminated is True


def test_a_fatal_heartbeat_still_ends_the_loop_and_kills_the_stage() -> None:
    client = UnauthorizedClient()
    heartbeat = Heartbeat(client, "job1", "asr-test", lease_ms=120_000, interval=0.05)  # type: ignore[arg-type]
    process = RunningProcess()
    heartbeat.attach(process)  # type: ignore[arg-type]

    heartbeat.start()
    try:
        assert heartbeat.lost.wait(timeout=1.0) is True
    finally:
        heartbeat.stop()

    assert process.terminated is True


def test_a_slow_renewal_is_never_given_a_timeout_past_the_lease() -> None:
    lease = 0.3
    client = SlowClient(lease)
    heartbeat = Heartbeat(client, "job1", "asr-test", lease_ms=int(lease * 1000), interval=0.05)  # type: ignore[arg-type]
    heartbeat.start()
    # Read the deadline after the grant, so this bound can only be looser than the
    # thread's own; the 10 ms covers clock reads landing either side of it.
    granted_until = time.monotonic() + lease
    try:
        assert heartbeat.lost.wait(timeout=4.0) is True
    finally:
        heartbeat.stop()

    assert client.calls, "the heartbeat never tried to renew"
    for timeout, called_at in client.calls:
        assert timeout is not None
        assert timeout <= max(0.1, granted_until - called_at) + 0.01
    assert client.calls[0][0] < heartbeat.call_timeout
