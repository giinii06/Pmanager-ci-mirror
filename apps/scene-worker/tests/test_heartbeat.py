from __future__ import annotations

import time
import urllib.error

from scene_worker.pipeline import Heartbeat


class RecordingClient:
    def __init__(self) -> None:
        self.events: list[str] = []

    def heartbeat(self, job_id: str, owner: str, *, timeout: float | None = None) -> None:
        self.events.append("job-heartbeat")

    def gpu_heartbeat(self, owner: str, *, timeout: float | None = None) -> None:
        self.events.append("gpu-heartbeat")

    def gpu_acquire(self, owner: str, task_kind: str, lease_ms: int) -> bool:
        return True

    def gpu_release(self, owner: str) -> None:
        pass


class UnreachableClient(RecordingClient):
    """Every renewal fails the way a paused API fails."""

    def heartbeat(self, job_id: str, owner: str, *, timeout: float | None = None) -> None:
        raise urllib.error.URLError("API paused")


class SlowClient(RecordingClient):
    """A renewal that outlives its own timeout, which is what a hung socket looks like."""

    def __init__(self, lease: float) -> None:
        super().__init__()
        self.lease = lease
        self.calls: list[tuple[float | None, float]] = []

    def heartbeat(self, job_id: str, owner: str, *, timeout: float | None = None) -> None:
        self.calls.append((timeout, time.monotonic()))
        time.sleep(4 * self.lease)
        raise TimeoutError("the renewal outlived its own timeout")


class RunningStage:
    def __init__(self) -> None:
        self.terminated = False

    def poll(self):
        return None

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        pass

    def wait(self, timeout=None) -> int:
        return 0


def test_an_unreachable_api_loses_the_lease_and_stops_the_stage() -> None:
    heartbeat = Heartbeat(UnreachableClient(), "job1", "scene-test", lease_ms=300, interval=0.05)  # type: ignore[arg-type]
    stage = RunningStage()
    heartbeat.attach(stage.terminate)  # type: ignore[arg-type]

    heartbeat.start()
    try:
        assert heartbeat.lost.wait(timeout=1.0) is True
    finally:
        heartbeat.stop()

    assert stage.terminated is True


def test_an_expired_gpu_lease_stops_the_stage_even_when_the_job_is_fine() -> None:
    client = RecordingClient()

    def beat(job_id: str, owner: str, *, timeout: float | None = None) -> None:
        client.events.append("job-heartbeat")

    def fail_gpu(owner: str, *, timeout: float | None = None) -> None:
        raise urllib.error.URLError("the GPU lease endpoint is down")

    client.heartbeat = beat  # type: ignore[assignment]
    client.gpu_heartbeat = fail_gpu  # type: ignore[assignment]
    heartbeat = Heartbeat(client, "job1", "scene-test", lease_ms=300, interval=0.05)  # type: ignore[arg-type]
    stage = RunningStage()
    heartbeat.attach(stage.terminate)  # type: ignore[arg-type]
    heartbeat.hold_gpu()

    heartbeat.start()
    try:
        assert heartbeat.lost.wait(timeout=1.5) is True
    finally:
        heartbeat.stop()

    assert stage.terminated is True


def test_a_slow_renewal_is_never_given_a_timeout_past_the_lease() -> None:
    lease = 0.3
    client = SlowClient(lease)
    heartbeat = Heartbeat(client, "job1", "scene-test", lease_ms=int(lease * 1000), interval=0.05)  # type: ignore[arg-type]
    heartbeat.start()
    granted_until = time.monotonic() + lease
    try:
        assert heartbeat.lost.wait(timeout=4.0) is True
    finally:
        heartbeat.stop()

    assert client.calls, "the heartbeat never tried to renew"
    for timeout, called_at in client.calls:
        assert timeout is not None
        assert timeout <= max(0.1, granted_until - called_at) + 0.01
