from __future__ import annotations

import logging
import os
import signal
import subprocess
import tempfile
import time
from pathlib import Path

log = logging.getLogger(__name__)

STOP_TIMEOUT = 30.0


def stage_pid_file(temp_dir: str) -> Path:
    """Where a stage process records itself. Outside the per-job workdir, because the
    workdir is removed when the job ends and this record has to outlive the worker."""
    return Path(temp_dir or tempfile.gettempdir()) / "asr-stage.pid"


def record_self(path: Path) -> None:
    """Write this process's identity where the next worker will look.

    Written by the stage itself, not by the parent: the parent can be killed between
    the fork and its own write, and that orphan is the bug.
    """
    pid = os.getpid()
    started = _start_of(pid)
    if started is None:
        raise RuntimeError(
            f"pid {pid} cannot read its own start time, so this stage refuses to load a "
            "model without a record"
        )
    path.write_text(f"{pid} {started}\n", encoding="utf-8")


def clear_self(path: Path) -> None:
    """Drop the record, so the next worker reads none rather than a stale one."""
    path.unlink(missing_ok=True)


def reap_stale_stage(path: Path, timeout: float = STOP_TIMEOUT) -> bool:
    """Kill the stage a dead worker left holding the card. True when the card is free."""
    record = _read_record(path)
    if record is None:
        clear_self(path)
        return True
    pid, started = record
    if _gone(pid, 0.0):
        clear_self(path)
        return True
    actual = _start_of(pid)
    if actual is None:
        log.warning("cannot identify the stage pid %s recorded in %s, leaving it alone", pid, path)
        return False
    if actual != started:
        clear_self(path)
        return True
    log.warning("stage pid %s outlived its worker", pid)
    if _terminate(pid, timeout):
        clear_self(path)
        return True
    log.warning("stage pid %s survived SIGKILL", pid)
    return False


def _start_of(pid: int) -> str | None:
    """The instant a process started, which a reused pid cannot repeat.

    Linux reads field 22 of /proc/<pid>/stat. `comm` can hold spaces and parentheses, so
    the fields are read after the last ')'. macOS has no /proc, so `ps` stands in.
    """
    if Path("/proc").exists():
        try:
            text = Path(f"/proc/{pid}/stat").read_text()
        except OSError:
            return None
        rest = text[text.rfind(")") + 2 :].split()
        return rest[19] if len(rest) > 19 else None
    try:
        completed = subprocess.run(
            ["ps", "-o", "lstart=", "-p", str(pid)],
            capture_output=True,
            timeout=STOP_TIMEOUT,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return completed.stdout.decode("utf-8", "replace").strip() or None


def _read_record(path: Path) -> tuple[int, str] | None:
    """The pid and start time a stage wrote, or None when there is no usable record."""
    try:
        line = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    pid_text, _, started = line.partition(" ")
    if not started:
        return None
    try:
        return int(pid_text), started
    except ValueError:
        return None


def _terminate(pid: int, timeout: float) -> bool:
    """Climb the same SIGTERM then SIGKILL ladder as `LlamaServer.stop`. True once gone."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            return True
        except OSError as error:
            log.warning("could not signal pid %s: %s", pid, error)
            return False
        if _gone(pid, timeout):
            return True
    return False


def _gone(pid: int, timeout: float) -> bool:
    """Whether the pid stops running within `timeout` seconds.

    A zombie counts as gone. The orphan reparents to PID 1, and a container whose
    PID 1 is the worker itself never reaps it, so the entry lingers in state Z and
    `kill(pid, 0)` keeps answering for a process that holds no memory, no port and
    no card.
    """
    deadline = time.monotonic() + timeout
    while True:
        state = _state_of(pid)
        if state is None:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return True
            except OSError:
                return False
        elif state in ("", "Z"):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)


def _state_of(pid: int) -> str | None:
    """The one-letter process state, '' when /proc has no entry, None without /proc.

    `comm` can hold spaces and parentheses, so the state is read after the last ')'.
    """
    if not Path("/proc").exists():
        return None
    try:
        text = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return ""
    return text[text.rfind(")") + 2 :].split(" ", 1)[0]
