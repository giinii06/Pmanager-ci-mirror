from __future__ import annotations

import base64
import logging
import struct
import threading
import time
from pathlib import Path
from typing import Any, Callable

from .chunk import Chunk, plan_chunks
from .client import JobFailure, LeaseLost, WorkerClient
from .config import Config
from .llama import LlamaServer

log = logging.getLogger(__name__)

GPU_RETRY_SECONDS = 5.0


def encode_vector(vector: list[float]) -> str:
    """Base64 of little-endian float32, which is what the API decodes."""
    return base64.b64encode(struct.pack(f"<{len(vector)}f", *vector)).decode("ascii")


class Heartbeat:
    """Keeps both leases alive and tells the pipeline when either is gone."""

    def __init__(self, client: WorkerClient, job_id: str, owner: str, lease_ms: int):
        self.client = client
        self.job_id = job_id
        self.owner = owner
        self.interval = max(5.0, lease_ms / 3000)
        self.lost = threading.Event()
        self.gpu = threading.Event()
        self._stopper: Callable[[], None] | None = None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="embedding-heartbeat", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    def attach(self, stopper: Callable[[], None]) -> None:
        self._stopper = stopper

    def detach(self) -> None:
        self._stopper = None

    def hold_gpu(self) -> None:
        self.gpu.set()

    def drop_gpu(self) -> None:
        self.gpu.clear()

    def abort(self) -> None:
        self.lost.set()
        stopper = self._stopper
        if stopper is not None:
            stopper()

    def _loop(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                self.client.heartbeat(self.job_id, self.owner)
                if self.gpu.is_set():
                    self.client.gpu_heartbeat(self.owner)
            except LeaseLost:
                log.warning("lease lost for %s, stopping the pipeline", self.job_id)
                self.abort()
                return
            except Exception as error:  # noqa: BLE001 - keep retrying transient faults
                log.warning("heartbeat error: %s", error)


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
        asset = claim["asset"]
        model = claim["model"]
        job_id = job["id"]
        dimensions = int(model["dimensions"])
        chunks = plan_chunks(claim["text"]["segments"])
        title = Path(str(asset["filename"])).stem
        documents = [title] + [chunk.text for chunk in chunks]

        self._report(job_id, "embedding", "starting", 2)
        acquired = self._acquire_gpu(heartbeat)
        if not acquired:
            raise JobFailure("GPU is busy with another job.")
        heartbeat.hold_gpu()

        server: Any = None
        try:
            server = self.server_factory()
            server.start()
            heartbeat.attach(server.terminate)
            self._report(job_id, "embedding", "starting", 5)

            vectors = self._embed(job_id, documents, server, dimensions, heartbeat)
            self._report(job_id, "writing", "writing", 95)

            if heartbeat.lost.is_set():
                raise LeaseLost("lease lost before the results were sent")
            self.client.complete(job_id, self.owner, self._payload(title, chunks, vectors))
        finally:
            try:
                if server is not None:
                    heartbeat.detach()
                    server.stop()
            finally:
                heartbeat.drop_gpu()
                self._release_gpu()

    def _payload(
        self,
        title: str,
        chunks: list[Chunk],
        vectors: list[list[float]],
    ) -> list[dict[str, Any]]:
        head = {
            "kind": "title",
            "chunkIndex": 0,
            "startMs": None,
            "endMs": None,
            "text": title,
            "vector": encode_vector(vectors[0]),
        }
        rest = [
            {
                "kind": "chunk",
                "chunkIndex": chunk.index,
                "startMs": chunk.start_ms,
                "endMs": chunk.end_ms,
                "text": chunk.text,
                "vector": encode_vector(vector),
            }
            for chunk, vector in zip(chunks, vectors[1:])
        ]
        return [head] + rest

    def _release_gpu(self) -> None:
        try:
            self.client.gpu_release(self.owner)
        except Exception as error:  # noqa: BLE001 - an unhandled lease expires on its own
            log.warning("could not release the GPU lease: %s", error)

    def _acquire_gpu(self, heartbeat: Heartbeat) -> bool:
        deadline = time.monotonic() + self.config.gpu_wait_seconds
        while not heartbeat.lost.is_set():
            if self.client.gpu_acquire(self.owner, "embedding", self.config.lease_ms):
                return True
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            log.info("GPU is busy, retrying in %.0fs", min(GPU_RETRY_SECONDS, remaining))
            heartbeat.lost.wait(min(GPU_RETRY_SECONDS, remaining))
        raise LeaseLost("lease lost while waiting for the GPU")

    def _embed(
        self,
        job_id: str,
        documents: list[str],
        server: Any,
        dimensions: int,
        heartbeat: Heartbeat,
    ) -> list[list[float]]:
        size = max(1, self.config.embedding_batch_size)
        vectors: list[list[float]] = []
        for start in range(0, len(documents), size):
            if heartbeat.lost.is_set():
                raise LeaseLost("lease lost during embedding")
            batch = documents[start : start + size]
            vectors.extend(server.embed(batch, dimensions))
            done = start + len(batch)
            self._report(job_id, "embedding", "embedding", 10 + 80 * done / len(documents))
        return vectors

    def _report(self, job_id: str, state: str, stage: str, progress: float) -> None:
        self.client.progress(job_id, self.owner, state, stage, progress)
