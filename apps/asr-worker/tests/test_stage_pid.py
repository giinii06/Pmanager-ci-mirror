from __future__ import annotations

import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from asr_worker import stage_pid
from asr_worker.stage_pid import reap_stale_stage


def spawn_recording_stage(path: Path) -> subprocess.Popen[str]:
    """A child that records itself the way the real stage does, then sleeps."""
    source = Path(stage_pid.__file__).resolve().parents[1]
    script = (
        "import sys, time\n"
        f"sys.path.insert(0, {str(source)!r})\n"
        "from pathlib import Path\n"
        "from asr_worker.stage_pid import record_self\n"
        f"record_self(Path({str(path)!r}))\n"
        "time.sleep(300)\n"
    )
    child = subprocess.Popen([sys.executable, "-c", script])
    deadline = time.monotonic() + 15.0
    while not path.exists():
        if child.poll() is not None or time.monotonic() >= deadline:
            raise AssertionError("the stage never recorded itself")
        time.sleep(0.02)
    return child


def test_a_stage_left_by_a_killed_worker_is_killed_and_its_record_cleared(tmp_path) -> None:
    path = tmp_path / "asr-stage.pid"
    orphan = spawn_recording_stage(path)
    try:
        # The real orphan lost its parent, so something else reaps it. Play that part,
        # otherwise it stays a zombie that still answers kill(pid, 0).
        threading.Thread(target=orphan.wait, daemon=True).start()

        assert reap_stale_stage(path, timeout=5.0) is True

        assert orphan.poll() is not None
        assert not path.exists()
    finally:
        orphan.kill()
        orphan.wait(timeout=5)
        path.unlink(missing_ok=True)


def test_a_record_whose_start_time_is_not_its_pid_s_own_is_cleared_alone(tmp_path) -> None:
    path = tmp_path / "asr-stage.pid"
    survivor = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
    try:
        path.write_text(f"{survivor.pid} Sun Jan  1 00:00:00 2000\n")

        assert reap_stale_stage(path, timeout=5.0) is True

        assert survivor.poll() is None
        assert not path.exists()
    finally:
        survivor.kill()
        survivor.wait(timeout=5)
        path.unlink(missing_ok=True)


def test_a_record_naming_a_pid_that_is_gone_is_cleared(tmp_path) -> None:
    path = tmp_path / "asr-stage.pid"
    finished = subprocess.Popen([sys.executable, "-c", "pass"])
    finished.wait(timeout=15)
    path.write_text(f"{finished.pid} 1234\n")

    assert reap_stale_stage(path, timeout=5.0) is True

    assert not path.exists()


def test_a_missing_record_reports_the_card_free(tmp_path) -> None:
    path = tmp_path / "asr-stage.pid"

    assert reap_stale_stage(path) is True

    assert not path.exists()


@pytest.mark.skipif(not Path("/proc").exists(), reason="the zombie shape is a container's")
def test_a_zombie_record_counts_as_gone(tmp_path) -> None:
    """A container whose PID 1 is the worker never reaps the orphan, so the /proc
    entry lingers in state Z and kill(pid, 0) keeps answering for a dead process."""
    path = tmp_path / "asr-stage.pid"
    orphan = spawn_recording_stage(path)
    try:
        # No waiter: the child stays a zombie, which is the shape a container
        # without an init leaves behind.
        started = time.monotonic()
        assert reap_stale_stage(path, timeout=5.0) is True
        elapsed = time.monotonic() - started

        assert elapsed < 2.0
        assert not path.exists()
    finally:
        orphan.kill()
        orphan.wait(timeout=5)
        path.unlink(missing_ok=True)
