from __future__ import annotations

import subprocess
import threading
import time
from pathlib import Path

import pytest

from translation_worker import llama as llama_module
from translation_worker.llama import reap_stale_server


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
        threading.Thread(target=orphan.wait, daemon=True).start()

        reap_stale_server(8080, "sleep", timeout=5.0)

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
