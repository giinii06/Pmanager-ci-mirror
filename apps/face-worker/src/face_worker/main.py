from __future__ import annotations

import logging
import signal
import sys
import threading
import time
from pathlib import Path
from typing import Any

from .client import FatalError, JobFailure, LeaseLost, WorkerClient
from .config import Config, load_config
from .pipeline import Heartbeat, Pipeline

log = logging.getLogger("face_worker")


def verify_model_dir(path: str) -> None:
    models = Path(path) / "models"
    if not models.is_dir() or not any(models.iterdir()):
        raise SystemExit(
            f"Face models are missing under {path}. Run the face-model-init service first "
            "(docker compose -f compose.yaml -f compose.face.models.yaml run --rm face-model-init)."
        )


class Worker:
    def __init__(self, config: Config):
        self.config = config
        self.client = WorkerClient(config.api_base_url, config.worker_token)
        self.pipeline = Pipeline(config, self.client)
        self.stop = threading.Event()
        self.current: Heartbeat | None = None

    def request_stop(self, reason: str) -> None:
        log.info("shutdown requested (%s)", reason)
        self.stop.set()
        heartbeat = self.current
        if heartbeat:
            heartbeat.abort()

    def run(self) -> int:
        log.info(
            "worker %s ready: model=%s api=%s sample=%dms",
            self.config.worker_id,
            self.config.model_dir,
            self.config.api_base_url,
            self.config.sample_ms,
        )

        while not self.stop.is_set():
            try:
                claim = self.client.claim(self.config.worker_id, self.config.lease_ms)
            except FatalError as error:
                log.error("%s", error)
                return 1

            if not claim:
                self.stop.wait(self.config.poll_seconds)
                continue

            try:
                self._run_job(claim)
            except FatalError as error:
                log.error("%s", error)
                return 1

        return 0

    def _run_job(self, claim: dict[str, Any]) -> None:
        job = claim["job"]
        job_id = job["id"]
        log.info(
            "job %s: %s (%ss)",
            job_id,
            claim["media"]["filename"],
            round((claim["media"]["durationMs"] or 0) / 1000),
        )

        heartbeat = Heartbeat(self.client, job_id, self.config.worker_id, self.config.lease_ms)
        self.current = heartbeat
        heartbeat.start()
        started = time.monotonic()
        try:
            self.pipeline.process(claim, heartbeat)
            log.info("job %s finished in %.1fs", job_id, time.monotonic() - started)
        except LeaseLost:
            log.warning("job %s: lease lost, leaving it to the queue", job_id)
        except FatalError:
            raise
        except JobFailure as error:
            log.error("job %s failed: %s", job_id, error)
            self._fail(job_id, str(error))
        except Exception as error:  # noqa: BLE001 - report every failure to the API
            log.exception("job %s failed", job_id)
            self._fail(job_id, f"{type(error).__name__}: {error}")
        finally:
            heartbeat.stop()
            self.current = None

    def _fail(self, job_id: str, message: str) -> None:
        try:
            self.client.fail(job_id, self.config.worker_id, message)
        except LeaseLost:
            log.warning("job %s: lease was already gone", job_id)
        except Exception:  # noqa: BLE001 - the loop must survive a reporting failure
            log.exception("could not report the failure for job %s", job_id)


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    config = load_config()
    verify_model_dir(config.model_dir)

    worker = Worker(config)
    signal.signal(signal.SIGTERM, lambda *_: worker.request_stop("SIGTERM"))
    signal.signal(signal.SIGINT, lambda *_: worker.request_stop("SIGINT"))
    return worker.run()


if __name__ == "__main__":
    raise SystemExit(main())
