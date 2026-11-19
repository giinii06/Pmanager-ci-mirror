from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable

from .client import ApiError, FatalError, LeaseLost, WorkerClient
from .config import Config
from .processes import terminate_group

log = logging.getLogger(__name__)

GPU_RETRY_SECONDS = 5.0
CODE_PATTERN = re.compile(r"\[([A-Z][A-Z_]{2,})\]")
CHECKPOINT_PATTERN = re.compile(r"^CHECKPOINT (\d+) (\d+) ([0-9a-f]{64})$")


def error_prefix(tail: str) -> str:
    """Lifts a `[CODE]` the stage already logged so the API can store it."""
    match = CODE_PATTERN.search(tail)
    return f"[{match.group(1)}] " if match else ""


def parse_checkpoint(line: str) -> tuple[int, int, str] | None:
    """The stage's durable-progress line: completed, total and log digest."""
    match = CHECKPOINT_PATTERN.match(line)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2)), match.group(3)


def resolve_media_path(media_root: str, stored: str) -> str:
    """The database keeps library-relative paths; the worker mounts the root."""
    return str(Path(media_root) / stored)


class Heartbeat:
    """Keeps both leases alive and tells the pipeline when either is gone.

    Fail-closed: the thread declares the lease lost as soon as it cannot confirm
    it before it expires, instead of retrying until a call happens to return.
    """

    def __init__(
        self,
        client: WorkerClient,
        job_id: str,
        owner: str,
        lease_ms: int,
        *,
        interval: float | None = None,
    ):
        self.client = client
        self.job_id = job_id
        self.owner = owner
        self.lease = lease_ms / 1000.0
        self.interval = max(5.0, lease_ms / 3000) if interval is None else interval
        self.call_timeout = max(1.0, self.lease / 4)  # one renewal inside the lease
        self.lost = threading.Event()
        self.gpu = threading.Event()
        self._stopper: Callable[[], None] | None = None
        self._stop = threading.Event()
        self._confirmed_until = 0.0
        self._gpu_until = 0.0
        self._thread = threading.Thread(target=self._loop, name="scene-heartbeat", daemon=True)

    def start(self) -> None:
        self._confirmed_until = time.monotonic() + self.lease
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    def attach(self, stopper: Callable[[], None]) -> None:
        self._stopper = stopper
        if self.lost.is_set():
            stopper()

    def detach(self) -> None:
        self._stopper = None

    def hold_gpu(self) -> None:
        self._gpu_until = time.monotonic() + self.lease
        self.gpu.set()

    def drop_gpu(self) -> None:
        self._gpu_until = 0.0
        self.gpu.clear()

    def abort(self) -> None:
        self.lost.set()
        stopper = self._stopper
        if stopper is not None:
            stopper()

    def _loop(self) -> None:
        while not self._stop.wait(self._next_wait()):
            if self._expired():
                self._lose("the lease expired before a heartbeat was confirmed")
                return
            self._beat()

    def _next_wait(self) -> float:
        """Wake on the interval, but never sleep past an unconfirmed deadline."""
        deadlines = [self._confirmed_until]
        if self.gpu.is_set():
            deadlines.append(self._gpu_until)
        return max(0.0, min(self.interval, min(deadlines) - time.monotonic()))

    def _expired(self) -> bool:
        now = time.monotonic()
        return now >= self._confirmed_until or (self.gpu.is_set() and now >= self._gpu_until)

    def _beat(self) -> None:
        now = time.monotonic()
        try:
            self.client.heartbeat(
                self.job_id,
                self.owner,
                timeout=min(self.call_timeout, max(0.1, self._confirmed_until - now)),
            )
            self._confirmed_until = time.monotonic() + self.lease
        except LeaseLost:
            self._lose(f"lease lost for {self.job_id}")
            return
        except Exception as error:  # noqa: BLE001 - transient while the lease still lives
            log.warning("heartbeat error: %s", error)
            return
        if not self.gpu.is_set():
            return
        now = time.monotonic()
        try:
            self.client.gpu_heartbeat(
                self.owner, timeout=min(self.call_timeout, max(0.1, self._gpu_until - now))
            )
            self._gpu_until = time.monotonic() + self.lease
        except LeaseLost:
            self._lose(f"GPU lease lost for {self.job_id}")
        except Exception as error:  # noqa: BLE001 - the deadline decides
            log.warning("GPU heartbeat error: %s", error)

    def _lose(self, message: str) -> None:
        log.warning("%s, stopping the pipeline", message)
        self.abort()


class Pipeline:
    def __init__(self, config: Config, client: WorkerClient):
        self.config = config
        self.client = client
        self.owner = config.worker_id

    def process(self, claim: dict[str, Any], heartbeat: Heartbeat) -> None:
        job = claim["job"]
        media = claim["media"]
        model = claim["model"]
        window = claim["window"]
        job_id = job["id"]

        self._report(job_id, "extracting", "extracting", 1)
        if not self._acquire_gpu(heartbeat):
            raise RuntimeError("GPU is busy with another job.")
        heartbeat.hold_gpu()

        workdir = Path(tempfile.mkdtemp(prefix="scene-job-", dir=self._temp_root()))
        claim_path = workdir / "claim.json"
        result_path = workdir / "scenes.json"
        claim_path.write_text(
            json.dumps(
                {
                    "jobId": job["id"],
                    "assetId": job["assetId"],
                    "fileVersion": job["fileVersion"],
                    "mediaPath": resolve_media_path(self.config.media_root, media["path"]),
                    "durationMs": media["durationMs"],
                    "modelDir": self.config.model_dir,
                    "modelId": model["id"],
                    "modelSha256": model["sha256"],
                    "pipelineVersion": model["pipelineVersion"],
                    "dimensions": model["dimensions"],
                    "windowMs": window["windowMs"],
                    "overlapMs": window["overlapMs"],
                    "maxWindows": self.config.max_windows,
                    "cacheDir": self.config.cache_dir,
                    "checkpointDir": self.config.checkpoint_dir,
                }
            ),
            encoding="utf-8",
        )

        process: subprocess.Popen[str] | None = None
        watchdog: threading.Timer | None = None
        log_path = workdir / "stage.log"
        try:
            with log_path.open("w", encoding="utf-8") as log_stream:
                process = subprocess.Popen(
                    [
                        sys.executable,
                        "-m",
                        "scene_worker.stage",
                        "--claim",
                        str(claim_path),
                        "--out",
                        str(result_path),
                    ],
                    stdout=subprocess.PIPE,
                    stderr=log_stream,
                    text=True,
                    bufsize=1,
                    start_new_session=True,
                )
                timed_out = threading.Event()

                def on_timeout() -> None:
                    timed_out.set()
                    terminate_group(process)

                watchdog = threading.Timer(self.config.stage_timeout_seconds, on_timeout)
                watchdog.daemon = True
                watchdog.start()
                heartbeat.attach(lambda: terminate_group(process))
                last_report = 0.0
                try:
                    assert process.stdout is not None
                    for line in process.stdout:
                        line = line.strip()
                        if line.startswith("CHECKPOINT "):
                            parsed = parse_checkpoint(line)
                            if parsed is not None:
                                self._checkpoint(job_id, *parsed)
                            continue
                        if not line.startswith("PROGRESS "):
                            continue
                        try:
                            fraction = float(line.split(" ", 1)[1])
                        except ValueError:
                            continue
                        now = time.monotonic()
                        if now - last_report < 1.0:
                            continue
                        last_report = now
                        self._report(job_id, "embedding", "embedding", 5 + 85 * fraction)
                    code = process.wait()
                finally:
                    heartbeat.detach()
                    watchdog.cancel()

                if heartbeat.lost.is_set():
                    raise LeaseLost("lease lost while the stage was running")
                if timed_out.is_set():
                    raise RuntimeError(
                        f"[PROCESS_TIMEOUT] scene stage exceeded "
                        f"{int(self.config.stage_timeout_seconds)}s"
                    )
                if code != 0:
                    tail = _tail(log_path)
                    raise RuntimeError(f"{error_prefix(tail)}scene stage failed: {tail}")

            self._report(job_id, "writing", "writing", 95)
            payload = json.loads(result_path.read_text(encoding="utf-8"))
            if heartbeat.lost.is_set():
                raise LeaseLost("lease lost before the results were sent")
            self.client.complete(
                job_id, self.owner, payload["scenes"], payload.get("coverage")
            )
            # The API now owns the windows; the durable prefix is done with.
            _remove_tree(self._checkpoint_root(job_id))
        finally:
            if watchdog is not None:
                watchdog.cancel()
            if process is not None:
                terminate_group(process)
            _remove_tree(workdir)
            heartbeat.drop_gpu()
            self._release_gpu()

    def _checkpoint_root(self, job_id: str) -> Path:
        return Path(self.config.checkpoint_dir) / job_id

    def _checkpoint(self, job_id: str, completed: int, total: int, digest: str) -> None:
        """Points the API at the manifest the stage just made durable."""
        manifest = str(self._checkpoint_root(job_id) / "manifest.json")
        try:
            self.client.checkpoint(job_id, self.owner, completed, total, manifest, digest)
        except LeaseLost:
            raise
        except ApiError as error:
            # The windows are already on disk; a refused row only costs the
            # next claim its hint, so the stage keeps running.
            log.warning("checkpoint for %s was refused: %s", job_id, error)
        except FatalError:
            raise

    def _temp_root(self) -> str:
        Path(self.config.temp_dir).mkdir(parents=True, exist_ok=True)
        return self.config.temp_dir

    def _release_gpu(self) -> None:
        try:
            self.client.gpu_release(self.owner)
        except Exception as error:  # noqa: BLE001 - an unhandled lease expires on its own
            log.warning("could not release the GPU lease: %s", error)

    def _acquire_gpu(self, heartbeat: Heartbeat) -> bool:
        deadline = time.monotonic() + self.config.gpu_wait_seconds
        while not heartbeat.lost.is_set():
            if self.client.gpu_acquire(self.owner, "scene", self.config.lease_ms):
                return True
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            log.info("GPU is busy, retrying in %.0fs", min(GPU_RETRY_SECONDS, remaining))
            heartbeat.lost.wait(min(GPU_RETRY_SECONDS, remaining))
        raise LeaseLost("lease lost while waiting for the GPU")

    def _report(self, job_id: str, state: str, stage: str, progress: float) -> None:
        self.client.progress(job_id, self.owner, state, stage, progress)


def _tail(path: Path, lines: int = 8) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace").strip().splitlines()
    except OSError:
        return "the stage left no log"
    return " | ".join(text[-lines:]) or "the stage left no log"


def _remove_tree(path: Path) -> None:
    import shutil

    shutil.rmtree(path, ignore_errors=True)
