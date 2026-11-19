"""Child-process lifetime rules shared by the worker and the stage.

`subprocess.run(timeout=...)` kills only the direct child, so an ffmpeg that
spawned its own workers can survive a timeout and keep a file or the GPU busy.
Every child here starts in its own session, and cancellation signals the whole
group: TERM, a short grace period, then KILL. stderr goes to a temporary file
and only its tail is read, so a repeating decoder error cannot grow memory.
"""

from __future__ import annotations

import os
import signal
import subprocess
import tempfile
from typing import Any

STDERR_TAIL_BYTES = 8 * 1024
GRACE_SECONDS = 10.0


class ProcessTimeout(RuntimeError):
    """The child exceeded its budget. The message carries the D-03 code."""


def terminate_group(process: subprocess.Popen[Any]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        process.terminate()
    try:
        process.wait(timeout=GRACE_SECONDS)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        process.kill()
    process.wait(timeout=GRACE_SECONDS)


def run_checked(
    command: list[str],
    *,
    timeout_seconds: float,
    capture_stdout: bool = False,
) -> subprocess.CompletedProcess[bytes]:
    """Runs one command to completion with a group kill and a bounded stderr."""
    with tempfile.TemporaryFile() as stderr_file:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE if capture_stdout else subprocess.DEVNULL,
            stderr=stderr_file,
            start_new_session=True,
        )
        try:
            stdout, _ = process.communicate(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            terminate_group(process)
            raise ProcessTimeout(
                f"[PROCESS_TIMEOUT] {command[0]} exceeded {timeout_seconds:.0f}s"
            ) from None

        stderr_file.seek(0, os.SEEK_END)
        size = stderr_file.tell()
        stderr_file.seek(max(0, size - STDERR_TAIL_BYTES))
        stderr = stderr_file.read()

    if process.returncode != 0:
        tail = stderr.decode("utf-8", "replace").strip()[-500:]
        raise RuntimeError(f"{command[0]} exited with {process.returncode}: {tail}")
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
