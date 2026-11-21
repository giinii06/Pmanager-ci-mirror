from __future__ import annotations

import json
import subprocess
import threading
import time
from pathlib import Path

import pytest

from embedding_worker import llama as llama_module
from embedding_worker.client import JobFailure
from embedding_worker.config import load_config
from embedding_worker.llama import LlamaServer, reap_stale_server


def make_config(tmp_path, **env: str):
    base = {
        "EMBEDDING_WORKER_TOKEN": "token-token-token",
        "EMBEDDING_MODEL_PATH": str(tmp_path / "model.gguf"),
    }
    base.update(env)
    return load_config(base)


class FakeResponse:
    def __init__(self, payload: dict):
        self.payload = payload

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_: object) -> bool:
        return False


def respond_with(monkeypatch, payload: dict) -> None:
    monkeypatch.setattr(
        llama_module.urllib.request,
        "urlopen",
        lambda request, timeout: FakeResponse(payload),
    )


def test_embed_returns_the_vectors_in_input_order_and_unit_length(monkeypatch, tmp_path) -> None:
    respond_with(
        monkeypatch,
        {
            "data": [
                {"index": 1, "embedding": [0.0, 0.0, 4.0]},
                {"index": 0, "embedding": [3.0, 4.0, 0.0]},
            ]
        },
    )

    vectors = LlamaServer(make_config(tmp_path)).embed(["first", "second"], 3)

    assert vectors[0] == pytest.approx([0.6, 0.8, 0.0])
    assert vectors[1] == pytest.approx([0.0, 0.0, 1.0])


def test_embed_refuses_a_vector_of_the_wrong_dimension(monkeypatch, tmp_path) -> None:
    respond_with(monkeypatch, {"data": [{"index": 0, "embedding": [1.0, 0.0]}]})

    with pytest.raises(JobFailure, match="2 dimensions, expected 3"):
        LlamaServer(make_config(tmp_path)).embed(["first"], 3)


def test_embed_reports_a_response_without_data(monkeypatch, tmp_path) -> None:
    respond_with(monkeypatch, {"error": "model does not support embeddings"})

    with pytest.raises(JobFailure, match="returned no embedding"):
        LlamaServer(make_config(tmp_path)).embed(["first"], 3)


def local_pid_file(monkeypatch, tmp_path) -> Path:
    """Keep the record out of the real temp dir, which every run on this host shares."""
    path = tmp_path / "llama-server-8080.pid"
    monkeypatch.setattr(llama_module, "pid_file", lambda port: path)
    return path


def test_a_server_left_by_a_killed_worker_is_killed_by_the_next_start(monkeypatch, tmp_path) -> None:
    path = local_pid_file(monkeypatch, tmp_path)
    orphan = subprocess.Popen(["sleep", "300"])
    try:
        path.write_text(str(orphan.pid))
        # The real orphan lost its parent, so something else reaps it. Play that part,
        # otherwise it stays a zombie that still answers kill(pid, 0).
        reaper = threading.Thread(target=orphan.wait, daemon=True)
        reaper.start()

        reap_stale_server(8080, "sleep", timeout=5.0)

        # Popen.poll() returns None while another thread holds its waitpid lock,
        # even if the child has already exited. Join the reaper before asserting.
        reaper.join(timeout=5.0)
        assert orphan.poll() is not None
        assert not path.exists()
    finally:
        orphan.kill()
        path.unlink(missing_ok=True)


def test_a_pid_now_carrying_another_command_is_left_alone(monkeypatch, tmp_path) -> None:
    path = local_pid_file(monkeypatch, tmp_path)
    survivor = subprocess.Popen(["sleep", "300"])
    try:
        path.write_text(str(survivor.pid))

        reap_stale_server(8080, "llama-server", timeout=5.0)

        assert survivor.poll() is None
        assert path.exists()
    finally:
        survivor.kill()
        survivor.wait(timeout=5)
        path.unlink(missing_ok=True)


@pytest.mark.skipif(not Path("/proc").exists(), reason="the zombie shape is a container's")
def test_a_zombie_left_by_the_worker_counts_as_gone(monkeypatch, tmp_path) -> None:
    """A container whose PID 1 is the worker never reaps the orphan, so the /proc
    entry lingers in state Z and kill(pid, 0) keeps answering for a dead process.
    On macOS launchd reaps the orphan, so only Linux can take this shape."""
    path = local_pid_file(monkeypatch, tmp_path)
    orphan = subprocess.Popen(["sleep", "300"])
    try:
        path.write_text(str(orphan.pid))
        # No thread calls wait(), so the child stays a zombie: the container's shape.
        started = time.monotonic()
        reap_stale_server(8080, "sleep", timeout=5.0)
        elapsed = time.monotonic() - started

        assert elapsed < 2.0
        assert not path.exists()
    finally:
        orphan.kill()
        orphan.wait(timeout=5)
        path.unlink(missing_ok=True)
