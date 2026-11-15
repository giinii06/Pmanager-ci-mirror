from __future__ import annotations

import json
import logging
import os
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, BinaryIO

from .client import JobFailure
from .config import Config

log = logging.getLogger(__name__)

MODEL_ALIAS = "Index-Translate-9B"
STOP_TIMEOUT = 30.0


def pid_file(port: int) -> Path:
    """Where the server that last held this port recorded itself.

    Keyed by port, which is what a second server collides on; the GPU lease already
    serialises who may start one. Host-local, because in a container the temp dir lives
    in that container's namespace and dies with it.
    """
    return Path(tempfile.gettempdir()) / f"llama-server-{port}.pid"


def reap_stale_server(port: int, expected: str, timeout: float = STOP_TIMEOUT) -> None:
    """Kill the llama-server a dead worker left behind on this port.

    A SIGKILLed worker runs no cleanup and nothing else knows its child exists, so the
    next worker to take the card is the only one who can. Idempotent: no file, a dead
    pid, an unreadable file, or a pid now carrying another command all do nothing.
    """
    path = pid_file(port)
    try:
        pid = int(path.read_text().strip())
    except (OSError, ValueError):
        return
    if _command_of(pid) != expected:
        return
    log.warning("llama-server pid %s outlived its worker on port %s", pid, port)
    if _terminate(pid, timeout):
        path.unlink(missing_ok=True)
    else:
        log.warning("llama-server pid %s survived SIGKILL", pid)


def _command_of(pid: int) -> str | None:
    """The program name behind a pid, or None when it cannot be read.

    `/proc` holds the exact argv[0] on Linux. macOS has no `/proc`, so `ps` stands in.
    Both platforms these workers run on are covered without a platform branch.
    """
    cmdline = Path(f"/proc/{pid}/cmdline")
    if cmdline.exists():
        try:
            first = cmdline.read_bytes().split(b"\0", 1)[0]
        except OSError:
            return None
        return Path(first.decode("utf-8", "replace")).name or None
    try:
        completed = subprocess.run(
            ["ps", "-o", "comm=", "-p", str(pid)],
            capture_output=True,
            timeout=STOP_TIMEOUT,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return Path(completed.stdout.decode("utf-8", "replace").strip()).name or None


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


def _record_pid(port: int, pid: int) -> None:
    """Write the pid through a rename, so a worker killed mid-write leaves no partial
    number that could name an unrelated process."""
    path = pid_file(port)
    handle, temp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(str(pid))
        os.replace(temp_name, path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise


class LlamaServer:
    """One llama-server process, started per job and stopped when it ends."""

    def __init__(self, config: Config):
        self.config = config
        self.base_url = f"http://127.0.0.1:{config.llama_port}"
        self.process: subprocess.Popen[bytes] | None = None
        self._log: BinaryIO | None = None

    def start(self) -> None:
        reap_stale_server(self.config.llama_port, Path(self.config.llama_server).name)
        self._log = tempfile.TemporaryFile()
        self.process = subprocess.Popen(
            [
                self.config.llama_server,
                "-m",
                self.config.model_path,
                "--alias",
                MODEL_ALIAS,
                "--host",
                "127.0.0.1",
                "--port",
                str(self.config.llama_port),
                "--ctx-size",
                str(self.config.llama_ctx),
                "--parallel",
                "1",
                "--n-gpu-layers",
                str(self.config.llama_gpu_layers),
                "--jinja",
                "--chat-template-kwargs",
                '{"enable_thinking":false}',
            ],
            stdout=subprocess.DEVNULL,
            stderr=self._log,
        )
        log.info("llama-server pid %s on %s", self.process.pid, self.base_url)
        _record_pid(self.config.llama_port, self.process.pid)
        self._wait_for_health()

    def _wait_for_health(self) -> None:
        assert self.process is not None
        deadline = time.monotonic() + self.config.llama_start_timeout
        while time.monotonic() < deadline:
            code = self.process.poll()
            if code is not None:
                raise JobFailure(
                    f"llama-server exited with code {code} before it was ready: "
                    f"{self.stderr_tail()}"
                )
            try:
                with urllib.request.urlopen(f"{self.base_url}/health", timeout=2) as response:
                    if response.status == 200:
                        return
            except (urllib.error.URLError, OSError):
                pass
            time.sleep(1.0)
        raise JobFailure(
            f"llama-server did not become ready within {self.config.llama_start_timeout:.0f}s: "
            f"{self.stderr_tail()}"
        )

    def chat(self, prompt: str) -> str:
        body: dict[str, Any] = {
            "model": MODEL_ALIAS,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
            "stream": False,
            "chat_template_kwargs": {"enable_thinking": False},
        }
        request = urllib.request.Request(
            f"{self.base_url}/v1/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers={"content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.config.request_timeout) as response:
                payload = json.loads(response.read())
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            raise JobFailure(
                f"llama-server refused the request with {error.code}: {detail[:300]}"
            ) from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise JobFailure(f"llama-server stopped answering: {error}") from error

        try:
            return str(payload["choices"][0]["message"]["content"])
        except (KeyError, IndexError, TypeError) as error:
            raise JobFailure(f"llama-server returned no message: {str(payload)[:300]}") from error

    def stop(self) -> None:
        process, self.process = self.process, None
        if process is None:
            self._close_log()
            return
        try:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=STOP_TIMEOUT)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=STOP_TIMEOUT)
        except subprocess.TimeoutExpired:
            log.warning("llama-server pid %s survived SIGKILL", process.pid)
            return
        finally:
            self._close_log()
            if process.poll() is not None:
                pid_file(self.config.llama_port).unlink(missing_ok=True)
        log.info("llama-server pid %s exited", process.pid)

    def terminate(self) -> None:
        process = self.process
        if process is not None and process.poll() is None:
            process.terminate()

    def stderr_tail(self, lines: int = 6) -> str:
        handle = self._log
        if handle is None:
            return "no output"
        try:
            handle.flush()
            handle.seek(0, os.SEEK_END)
            handle.seek(max(0, handle.tell() - 8192))
            text = handle.read().decode("utf-8", "replace").strip()
        except (OSError, ValueError):
            return "no output"
        return " | ".join(text.splitlines()[-lines:]) or "no output"

    def _close_log(self) -> None:
        handle, self._log = self._log, None
        if handle is not None:
            handle.close()
