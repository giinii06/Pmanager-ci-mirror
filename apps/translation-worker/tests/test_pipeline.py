from __future__ import annotations

import json
import threading
import time
import urllib.error

import pytest

from translation_worker import pipeline as pipeline_module
from translation_worker.client import ApiError, FatalError, JobFailure, LeaseLost, WorkerClient
from translation_worker.config import load_config
from translation_worker.main import Worker
from translation_worker.pipeline import Heartbeat, Pipeline

SEGMENTS = [
    {"seq": 0, "startMs": 0, "endMs": 1_200, "text": "こんにちは"},
    {"seq": 1, "startMs": 2_000, "endMs": 3_000, "text": "元気ですか"},
    {"seq": 2, "startMs": 3_500, "endMs": 4_200, "text": "ありがとう"},
]


def make_config(tmp_path, **env: str):
    base = {
        "TRANSLATION_WORKER_TOKEN": "token-token-token",
        "TRANSLATION_MODEL_PATH": str(tmp_path / "model.gguf"),
        "RESULT_DIR": str(tmp_path / "results"),
        "WORKER_ID": "worker-1",
        "TRANSLATION_BATCH_SEGMENTS": "2",
    }
    base.update(env)
    return load_config(base)


def make_claim(segments: list[dict] = SEGMENTS) -> dict:
    return {
        "job": {
            "id": "job-1",
            "assetId": "asset-1",
            "fileVersion": 3,
            "sourceLanguage": "ja",
            "targetLanguage": "ko",
        },
        "source": {
            "transcriptId": "tr-1",
            "language": "ja",
            "plainText": "\n".join(segment["text"] for segment in segments),
            "segments": segments,
        },
        "model": {
            "id": "IndexTeam/Index-Translate-9B-GGUF",
            "revision": "main",
            "sha256": "a" * 64,
            "promptVersion": "1",
            "pipelineVersion": "1",
        },
    }


class FakeClient:
    def __init__(self, acquire: list[bool] | None = None):
        self.events: list[tuple[str, object]] = []
        self.acquire_results = list(acquire or [True])
        self.completed: dict | None = None
        self.failed: str | None = None

    def heartbeat(self, job_id: str, owner: str, *, timeout: float | None = None) -> None:
        self.events.append(("heartbeat", job_id))

    def progress(self, job_id: str, owner: str, state: str, stage: str, progress: float) -> None:
        self.events.append(("progress", (state, stage, progress)))

    def complete(self, job_id, owner, translation_id, result_dir, plain_text, segments):
        self.completed = {
            "translation_id": translation_id,
            "result_dir": result_dir,
            "plain_text": plain_text,
            "segments": segments,
        }
        self.events.append(("complete", result_dir))
        return {"translationId": translation_id}

    def fail(self, job_id: str, owner: str, message: str) -> dict:
        self.failed = message
        self.events.append(("fail", message))
        return {"state": "failed"}

    def gpu_acquire(self, owner: str, task_kind: str, lease_ms: int) -> bool:
        self.events.append(("acquire", task_kind))
        return self.acquire_results.pop(0) if self.acquire_results else False

    def gpu_heartbeat(self, owner: str, *, timeout: float | None = None) -> None:
        self.events.append(("gpu_heartbeat", owner))

    def gpu_release(self, owner: str) -> None:
        self.events.append(("release", owner))

    def names(self) -> list[str]:
        return [name for name, _ in self.events]


class FakeServer:
    def __init__(self, client: FakeClient | None = None, on_chat=None):
        self.started = False
        self.stopped = False
        self.events = client.events if client else []
        self.on_chat = on_chat

    def start(self) -> None:
        self.started = True

    def chat(self, prompt: str) -> str:
        if self.on_chat:
            self.on_chat()
        block = prompt.split("【源文】")[1].strip().splitlines()[0]
        return json.dumps(
            [{"id": cue["id"], "text": f"번역:{cue['text']}"} for cue in json.loads(block)],
            ensure_ascii=False,
        )

    def stop(self) -> None:
        self.stopped = True
        self.events.append(("stop", None))

    def terminate(self) -> None:
        self.events.append(("terminate", None))


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


def run_pipeline(config, client: FakeClient, server: FakeServer) -> None:
    heartbeat = Heartbeat(client, "job-1", "worker-1", config.lease_ms)
    Pipeline(config, client, server_factory=lambda: server).process(make_claim(), heartbeat)


def test_one_cue_per_source_cue_with_the_source_timings(tmp_path) -> None:
    client = FakeClient()
    run_pipeline(make_config(tmp_path), client, FakeServer(client))

    segments = client.completed["segments"]
    assert [(s["seq"], s["startMs"], s["endMs"]) for s in segments] == [
        (s["seq"], s["startMs"], s["endMs"]) for s in SEGMENTS
    ]
    assert [s["text"] for s in segments] == [f"번역:{s['text']}" for s in SEGMENTS]
    assert client.completed["plain_text"] == "\n".join(f"번역:{s['text']}" for s in SEGMENTS)


def test_results_land_in_the_relative_directory_the_api_expects(tmp_path) -> None:
    client = FakeClient()
    run_pipeline(make_config(tmp_path), client, FakeServer(client))

    assert client.completed["result_dir"] == "asset-1/3/translations/tr-1/ko/aaaaaaaa_1_1"
    target = tmp_path / "results" / client.completed["result_dir"]
    stored = json.loads((target / "translation.json").read_text(encoding="utf-8"))
    assert stored["targetLanguage"] == "ko"
    assert stored["sourceTranscriptId"] == "tr-1"
    assert stored["modelSha256"] == "a" * 64
    assert [segment["seq"] for segment in stored["segments"]] == [0, 1, 2]
    assert (target / "subtitles.srt").is_file()
    assert (target / "subtitles.txt").read_text(encoding="utf-8") == client.completed["plain_text"]


def test_the_written_vtt_holds_each_line_through_the_silence(tmp_path) -> None:
    client = FakeClient()
    run_pipeline(make_config(tmp_path), client, FakeServer(client))

    vtt = (tmp_path / "results" / client.completed["result_dir"] / "subtitles.vtt").read_text(
        encoding="utf-8"
    )
    assert cue_times(vtt) == [(0, 2_000), (2_000, 3_500), (3_500, 4_200)]


def test_progress_runs_from_the_server_start_to_the_write(tmp_path) -> None:
    client = FakeClient()
    run_pipeline(make_config(tmp_path), client, FakeServer(client))

    progress = [payload for name, payload in client.events if name == "progress"]
    assert progress[0] == ("translating", "starting", 2.0)
    assert ("translating", "starting", 5.0) in progress
    assert ("translating", "translating", 50.0) in progress
    assert ("translating", "translating", 90.0) in progress
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


def test_a_failed_release_leaves_the_completed_job_alone(tmp_path) -> None:
    class FlakyRelease(FakeClient):
        def gpu_release(self, owner: str) -> None:
            self.events.append(("release", owner))
            raise FatalError("API /worker/gpu/release is unreachable")

    client = FlakyRelease()
    run_pipeline(make_config(tmp_path), client, FakeServer(client))

    assert client.completed is not None


def test_a_lost_lease_stops_the_server_and_completes_nothing(tmp_path) -> None:
    client = FakeClient()
    heartbeat = Heartbeat(client, "job-1", "worker-1", 120_000)
    server = FakeServer(client, on_chat=heartbeat.lost.set)

    with pytest.raises(LeaseLost):
        Pipeline(make_config(tmp_path), client, server_factory=lambda: server).process(
            make_claim(), heartbeat
        )

    assert client.completed is None
    assert server.stopped is True
    assert "release" in client.names()


def test_abort_marks_the_lease_lost_and_stops_the_server() -> None:
    client = FakeClient()
    heartbeat = Heartbeat(client, "job-1", "worker-1", 120_000)
    terminated: list[bool] = []
    heartbeat.attach(lambda: terminated.append(True))

    heartbeat.abort()

    assert heartbeat.lost.is_set()
    assert terminated == [True]


def wait_for(predicate, seconds: float = 2.0) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("the heartbeat thread did not make the expected call")


def test_the_heartbeat_refreshes_the_job_lease_and_only_then_the_gpu_lease() -> None:
    client = FakeClient()
    heartbeat = Heartbeat(client, "job-1", "worker-1", 120_000)
    heartbeat.interval = 0.01
    heartbeat.start()
    try:
        wait_for(lambda: "heartbeat" in client.names())
        assert "gpu_heartbeat" not in client.names()

        heartbeat.hold_gpu()
        wait_for(lambda: "gpu_heartbeat" in client.names())
    finally:
        heartbeat.stop()


def test_a_running_job_keeps_the_gpu_lease_alive(tmp_path) -> None:
    client = FakeClient()
    heartbeat = Heartbeat(client, "job-1", "worker-1", 120_000)
    heartbeat.interval = 0.01
    heartbeat.start()
    server = FakeServer(client, on_chat=lambda: wait_for(lambda: "gpu_heartbeat" in client.names()))
    try:
        Pipeline(make_config(tmp_path), client, server_factory=lambda: server).process(
            make_claim(), heartbeat
        )
    finally:
        heartbeat.stop()

    assert client.completed is not None


def test_a_rejected_payload_fails_the_job_instead_of_the_worker(monkeypatch) -> None:
    client = WorkerClient("http://127.0.0.1:1", "token-token-token")

    def reject(path: str, body: dict) -> dict:
        raise ApiError(path, 422, "Translated cues must match the source cue count.")

    monkeypatch.setattr(client, "_post", reject)

    with pytest.raises(JobFailure, match="must match the source cue count"):
        client.complete("job-1", "worker-1", "translation-1", "asset-1/1", "", [])


def test_a_busy_gpu_reaches_the_api_with_the_documented_message(tmp_path) -> None:
    client = FakeClient(acquire=[False])
    config = make_config(tmp_path, GPU_WAIT_SECONDS="0")
    worker = Worker(config)
    worker.client = client
    worker.pipeline = Pipeline(config, client, server_factory=lambda: FakeServer(client))

    worker._run_job(make_claim())

    assert client.failed == "GPU is busy with another job."


def test_a_lost_lease_is_left_to_the_queue_instead_of_reported(tmp_path) -> None:
    client = FakeClient()
    worker = Worker(make_config(tmp_path))
    worker.client = client

    class LostPipeline:
        def process(self, claim, heartbeat):
            raise LeaseLost("gone")

    worker.pipeline = LostPipeline()

    worker._run_job(make_claim())

    assert client.failed is None


class UnreachableClient(FakeClient):
    """Every renewal fails the way a paused API fails."""

    def heartbeat(self, job_id: str, owner: str, *, timeout: float | None = None) -> None:
        self.events.append(("heartbeat", timeout))
        raise urllib.error.URLError("API paused")


class SlowClient(FakeClient):
    """A renewal that outlives its own timeout, which is what a hung socket looks like."""

    def __init__(self, lease: float):
        super().__init__()
        self.lease = lease
        self.calls: list[tuple[float | None, float]] = []

    def heartbeat(self, job_id: str, owner: str, *, timeout: float | None = None) -> None:
        self.calls.append((timeout, time.monotonic()))
        time.sleep(4 * self.lease)
        raise TimeoutError("the renewal outlived its own timeout")


def test_an_unreachable_api_loses_the_lease_instead_of_retrying_forever() -> None:
    """A renewal that cannot be confirmed before the lease ends means the card is gone."""
    client = UnreachableClient()
    heartbeat = Heartbeat(client, "job-1", "worker-1", lease_ms=300, interval=0.05)
    stopped = threading.Event()
    heartbeat.attach(stopped.set)

    heartbeat.start()
    try:
        assert heartbeat.lost.wait(timeout=1.0) is True
    finally:
        heartbeat.stop()

    assert stopped.is_set()


def test_a_slow_renewal_is_never_given_a_timeout_past_the_lease() -> None:
    lease = 0.3
    client = SlowClient(lease)
    heartbeat = Heartbeat(client, "job-1", "worker-1", lease_ms=int(lease * 1000), interval=0.05)
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


class LoadingServer:
    """A server whose model load only ends when the test lets it."""

    def __init__(self):
        self.started = threading.Event()
        self.terminated = threading.Event()
        self._release = threading.Event()

    def start(self) -> None:
        self.started.set()
        self._release.wait(5.0)
        if self.terminated.is_set():
            raise JobFailure("llama-server exited with code -15 before it was ready")

    def terminate(self) -> None:
        self.terminated.set()
        self._release.set()

    def stop(self) -> None:
        self.terminate()


def test_a_lease_lost_during_the_model_load_stops_the_server(tmp_path) -> None:
    """The load is the longest stretch on the card, and start() is where the model
    takes it, so a lease lost inside the load has to end the load."""
    client = FakeClient()
    heartbeat = Heartbeat(client, "job-1", "worker-1", lease_ms=300, interval=0.05)
    server = LoadingServer()
    pipeline = Pipeline(make_config(tmp_path), client, server_factory=lambda: server)

    def lose_once_loading() -> None:
        assert server.started.wait(2.0)
        heartbeat.abort()

    threading.Thread(target=lose_once_loading, daemon=True).start()
    started = time.monotonic()
    with pytest.raises(LeaseLost):
        pipeline.process(make_claim(), heartbeat)
    elapsed = time.monotonic() - started

    # LoadingServer.start() waits five seconds unless something releases it, so a
    # short run is the difference between ending the load and outlasting it.
    assert elapsed < 1.0
    assert server.terminated.is_set()
