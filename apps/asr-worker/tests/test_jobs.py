from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from asr_worker.client import FatalError, LeaseLost, WorkerClient


class StubApi:
    """Minimal stand-in for the Fastify worker endpoints."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, dict[str, Any], dict[str, str]]] = []
        self.responses: list[tuple[int, dict[str, Any]]] = []
        self.token = "test-token"
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - stdlib naming
                length = int(self.headers.get("content-length", "0"))
                body = json.loads(self.rfile.read(length) or b"{}")
                stub.requests.append((self.path, body, {k.lower(): v for k, v in self.headers.items()}))
                status, payload = stub.responses.pop(0)
                raw = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args: Any) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def reply(self, status: int, payload: dict[str, Any]) -> None:
        self.responses.append((status, payload))

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def api() -> Any:
    stub = StubApi()
    yield stub
    stub.close()


def test_claim_returns_the_job_and_media(api: StubApi) -> None:
    api.reply(200, {"job": {"id": "job1"}, "media": {"path": "Videos/a.mp4"}})
    client = WorkerClient(api.base_url, "test-token")

    claim = client.claim("worker-a", 120_000)

    assert claim is not None
    assert claim["job"]["id"] == "job1"
    path, body, headers = api.requests[0]
    assert path == "/worker/asr/claim"
    assert body == {"owner": "worker-a", "leaseMs": 120_000}
    assert headers["x-worker-token"] == "test-token"


def test_empty_queue_returns_none(api: StubApi) -> None:
    api.reply(200, {"job": None})
    assert WorkerClient(api.base_url, "test-token").claim("worker-a", 120_000) is None


def test_bad_token_is_fatal(api: StubApi) -> None:
    api.reply(401, {"error": "unauthorized"})
    with pytest.raises(FatalError):
        WorkerClient(api.base_url, "wrong").claim("worker-a", 120_000)


def test_lease_conflict_stops_the_worker(api: StubApi) -> None:
    api.reply(409, {"error": "lease_lost"})
    with pytest.raises(LeaseLost):
        WorkerClient(api.base_url, "test-token").heartbeat("job1", "worker-a")


def test_progress_is_clamped_and_rounded(api: StubApi) -> None:
    api.reply(204, {})
    WorkerClient(api.base_url, "test-token").progress(
        "job1", "worker-a", "transcribing", "transcribing", 140
    )
    _, body, _ = api.requests[0]
    assert body["progress"] == 99


def test_a_long_failure_message_is_truncated_to_the_api_limit(api: StubApi) -> None:
    api.reply(200, {"state": "queued"})
    WorkerClient(api.base_url, "test-token").fail("job1", "worker-a", "x" * 3_000)
    _, body, _ = api.requests[0]
    assert len(body["message"]) == 2_000


def test_server_errors_are_retried(api: StubApi) -> None:
    api.reply(500, {"error": "boom"})
    api.reply(204, {})
    client = WorkerClient(api.base_url, "test-token")
    client.timeout = 2
    client.progress("job1", "worker-a", "aligning", "aligning", 60)
    assert len(api.requests) == 2
