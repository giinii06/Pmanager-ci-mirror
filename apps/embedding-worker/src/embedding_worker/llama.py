from __future__ import annotations

import json
import logging
import math
import os
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from typing import Any, BinaryIO

from .client import JobFailure
from .config import Config

log = logging.getLogger(__name__)

MODEL_ALIAS = "Qwen3-Embedding-4B"
STOP_TIMEOUT = 30.0


class LlamaServer:
    """One llama-server process, started per job and stopped when it ends."""

    def __init__(self, config: Config):
        self.config = config
        self.base_url = f"http://127.0.0.1:{config.llama_port}"
        self.process: subprocess.Popen[bytes] | None = None
        self._log: BinaryIO | None = None

    def start(self) -> None:
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
                "--embedding",
                "--pooling",
                "last",
            ],
            stdout=subprocess.DEVNULL,
            stderr=self._log,
        )
        log.info("llama-server pid %s on %s", self.process.pid, self.base_url)
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

    def embed(self, texts: list[str], dimensions: int) -> list[list[float]]:
        body: dict[str, Any] = {"model": MODEL_ALIAS, "input": texts}
        request = urllib.request.Request(
            f"{self.base_url}/v1/embeddings",
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
            entries = sorted(payload["data"], key=lambda entry: int(entry.get("index", 0)))
            vectors = [[float(value) for value in entry["embedding"]] for entry in entries]
        except (KeyError, TypeError, ValueError) as error:
            raise JobFailure(f"llama-server returned no embedding: {str(payload)[:300]}") from error

        if len(vectors) != len(texts):
            raise JobFailure(
                f"llama-server returned {len(vectors)} vectors for {len(texts)} texts"
            )

        normalized: list[list[float]] = []
        for vector in vectors:
            if len(vector) != dimensions:
                raise JobFailure(
                    f"llama-server returned {len(vector)} dimensions, expected {dimensions}"
                )
            norm = math.sqrt(sum(value * value for value in vector))
            if not math.isfinite(norm) or norm <= 0:
                raise JobFailure("llama-server returned a vector with no direction")
            normalized.append([value / norm for value in vector])
        return normalized

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
