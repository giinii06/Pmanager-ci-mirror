from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from .client import JobFailure, LeaseLost, WorkerClient
from .config import Config
from .llama import LlamaServer
from .subtitles import Cue, cues_from_segments, to_srt, to_txt, to_vtt
from .translate import Translator

log = logging.getLogger(__name__)

GPU_RETRY_SECONDS = 5.0
SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def safe_segment(value: str, limit: int = 40) -> str:
    cleaned = SAFE.sub("-", value.strip()).strip("-")
    return (cleaned or "unknown")[:limit]


class Heartbeat:
    """Keeps both leases alive and tells the pipeline when either is gone.

    Fail-closed: the thread declares the lease lost as soon as it cannot confirm it
    before it expires, instead of retrying until a call happens to return.
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
        self._confirmed_until = 0.0  # monotonic; the job lease is known live until here
        self._gpu_until = 0.0  # monotonic; the card is known ours until here
        self._thread = threading.Thread(
            target=self._loop, name="translation-heartbeat", daemon=True
        )

    def start(self) -> None:
        self._confirmed_until = time.monotonic() + self.lease  # claim() just granted it
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    def attach(self, stopper: Callable[[], None]) -> None:
        self._stopper = stopper
        if self.lost.is_set():
            stopper()  # the lease went while the caller was setting up

    def detach(self) -> None:
        self._stopper = None

    def hold_gpu(self) -> None:
        self._gpu_until = time.monotonic() + self.lease  # the acquire just granted it
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
        """Wake on the interval, but never sleep past an unconfirmed deadline: that
        instant is when the card may already belong to someone else."""
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
            return  # the deadline decides, not this exception
        if not self.gpu.is_set():
            return
        now = time.monotonic()  # the job call above may have taken a while
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
        self.abort()  # sets `lost`, then terminates the server


class Pipeline:
    def __init__(
        self,
        config: Config,
        client: WorkerClient,
        server_factory: Callable[[], Any] | None = None,
    ):
        self.config = config
        self.client = client
        self.owner = config.worker_id
        self.server_factory = server_factory or (lambda: LlamaServer(config))

    def process(self, claim: dict[str, Any], heartbeat: Heartbeat) -> None:
        job = claim["job"]
        source = claim["source"]
        model = claim["model"]
        job_id = job["id"]
        cues = cues_from_segments(source["segments"])
        if not cues:
            raise JobFailure("The source transcript has no cues to translate.")

        self._report(job_id, "translating", "starting", 2)
        acquired = self._acquire_gpu(heartbeat)
        if not acquired:
            raise JobFailure("GPU is busy with another job.")
        heartbeat.hold_gpu()

        server: Any = None
        try:
            server = self.server_factory()
            # Attach before the load: start() is where the model claims the card, and
            # a lease lost mid-load has to be able to stop it.
            heartbeat.attach(server.terminate)
            if heartbeat.lost.is_set():
                raise LeaseLost("lease lost before the model was loaded")
            try:
                server.start()
            except JobFailure:
                if heartbeat.lost.is_set():
                    raise LeaseLost("lease lost while the model was loading") from None
                raise
            if heartbeat.lost.is_set():
                raise LeaseLost("lease lost while the model was loading")
            self._report(job_id, "translating", "starting", 5)

            translated = self._translate(job_id, cues, server, job, heartbeat)
            self._report(job_id, "writing", "writing", 95)

            relative = self._result_dir(job, source, model)
            plain_text = "\n".join(cue.text for cue in translated)
            self._write(relative, job, source, model, translated, plain_text)

            if heartbeat.lost.is_set():
                raise LeaseLost("lease lost before the results were sent")
            self.client.complete(
                job_id,
                self.owner,
                f"{safe_segment(job['assetId'], 32)}-{uuid.uuid4().hex[:12]}",
                relative,
                plain_text,
                [cue.as_payload() for cue in translated],
            )
        finally:
            try:
                if server is not None:
                    heartbeat.detach()
                    server.stop()
            finally:
                heartbeat.drop_gpu()
                self._release_gpu()

    def _release_gpu(self) -> None:
        try:
            self.client.gpu_release(self.owner)
        except Exception as error:  # noqa: BLE001 - an unhandled lease expires on its own
            log.warning("could not release the GPU lease: %s", error)

    def _acquire_gpu(self, heartbeat: Heartbeat) -> bool:
        deadline = time.monotonic() + self.config.gpu_wait_seconds
        while not heartbeat.lost.is_set():
            if self.client.gpu_acquire(self.owner, "translation", self.config.lease_ms):
                return True
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            log.info("GPU is busy, retrying in %.0fs", min(GPU_RETRY_SECONDS, remaining))
            heartbeat.lost.wait(min(GPU_RETRY_SECONDS, remaining))
        raise LeaseLost("lease lost while waiting for the GPU")

    def _translate(
        self,
        job_id: str,
        cues: list[Cue],
        server: Any,
        job: dict[str, Any],
        heartbeat: Heartbeat,
    ) -> list[Cue]:
        translator = Translator(
            server.chat,
            batch_size=self.config.batch_segments,
            target_language=str(job["targetLanguage"]),
            on_batch=lambda done, total: self._on_batch(done, total, job_id, heartbeat),
        )
        return translator.run(cues)

    def _on_batch(self, done: int, total: int, job_id: str, heartbeat: Heartbeat) -> None:
        if heartbeat.lost.is_set():
            raise LeaseLost("lease lost during translation")
        self._report(job_id, "translating", "translating", 10 + 80 * done / total)

    def _report(self, job_id: str, state: str, stage: str, progress: float) -> None:
        self.client.progress(job_id, self.owner, state, stage, progress)

    def _result_dir(
        self, job: dict[str, Any], source: dict[str, Any], model: dict[str, Any]
    ) -> str:
        # The API leaves modelSha256 empty until an operator pins the file, so the
        # key must still name a directory in that case.
        sha = str(model.get("sha256") or "").strip()[:8] or "nosha"
        key = "_".join(
            safe_segment(part)
            for part in (sha, str(model["promptVersion"]), str(model["pipelineVersion"]))
        )
        return "/".join(
            (
                safe_segment(str(job["assetId"]), 32),
                str(int(job["fileVersion"])),
                "translations",
                safe_segment(str(source["transcriptId"]), 32),
                safe_segment(str(job["targetLanguage"]), 12),
                key,
            )
        )

    def _write(
        self,
        relative: str,
        job: dict[str, Any],
        source: dict[str, Any],
        model: dict[str, Any],
        cues: list[Cue],
        plain_text: str,
    ) -> None:
        target = Path(self.config.result_dir) / relative
        target.mkdir(parents=True, exist_ok=True)
        _write_json(
            target / "translation.json",
            {
                "assetId": job["assetId"],
                "fileVersion": job["fileVersion"],
                "sourceTranscriptId": source["transcriptId"],
                "sourceLanguage": job["sourceLanguage"],
                "targetLanguage": job["targetLanguage"],
                "modelId": model["id"],
                "modelSha256": model.get("sha256") or "",
                "promptVersion": model["promptVersion"],
                "pipelineVersion": model["pipelineVersion"],
                "createdAt": int(time.time() * 1000),
                "plainText": plain_text,
                "segments": [cue.as_payload() for cue in cues],
            },
        )
        _write_text(target / "subtitles.vtt", to_vtt(cues))
        _write_text(target / "subtitles.srt", to_srt(cues))
        _write_text(target / "subtitles.txt", to_txt(cues))


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=1)
        os.replace(temp_name, path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(text)
        os.replace(temp_name, path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise
