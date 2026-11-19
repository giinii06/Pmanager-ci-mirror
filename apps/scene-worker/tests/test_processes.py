from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

import pytest

from scene_worker import processes


def _alive(pid: int) -> bool:
    """True while the pid exists and is not a zombie waiting to be reaped."""
    result = subprocess.run(
        ["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True, timeout=5
    )
    state = result.stdout.strip()
    return bool(state) and not state.startswith("Z")


def test_run_checked_returns_stdout() -> None:
    result = processes.run_checked(
        [sys.executable, "-c", "print('hello')"],
        timeout_seconds=10,
        capture_stdout=True,
    )

    assert result.stdout.strip() == b"hello"


def test_run_checked_reports_the_exit_code_and_the_stderr_tail() -> None:
    with pytest.raises(RuntimeError) as caught:
        processes.run_checked(
            [
                sys.executable,
                "-c",
                "import sys; sys.stderr.write('decoder exploded'); sys.exit(3)",
            ],
            timeout_seconds=10,
        )

    assert "exited with 3" in str(caught.value)
    assert "decoder exploded" in str(caught.value)


def test_a_timeout_kills_the_whole_group(tmp_path: Path) -> None:
    pid_file = tmp_path / "child.pid"
    script = (
        "import subprocess, sys, time\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        "open(sys.argv[1], 'w').write(str(child.pid))\n"
        "time.sleep(60)\n"
    )

    with pytest.raises(processes.ProcessTimeout) as caught:
        processes.run_checked(
            [sys.executable, "-c", script, str(pid_file)], timeout_seconds=1
        )

    assert "[PROCESS_TIMEOUT]" in str(caught.value)

    child_pid = int(pid_file.read_text())
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if not _alive(child_pid):
            return
        time.sleep(0.05)
    pytest.fail("the grandchild survived the group kill")


def test_terminate_group_escalates_when_term_is_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(processes, "GRACE_SECONDS", 0.3)
    process = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)",
        ],
        start_new_session=True,
    )
    started = time.monotonic()

    processes.terminate_group(process)

    assert process.poll() is not None
    assert time.monotonic() - started < 5
