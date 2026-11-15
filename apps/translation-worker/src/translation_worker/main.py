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
from .translate import TranslationError

log = logging.getLogger("translation_worker")


def verify_model_file(path: str) -> None:
    if not Path(path).is_file():
        raise SystemExit(
            f"Translation model {path} is missing. Run the translation-model-init service first "
            "(docker compose -f compose.yaml -f compose.translation.models.yaml run --rm "
            "translation-model-init)."
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
            "worker %s ready: model=%s api=%s llama=%s port=%s",
            self.config.worker_id,
            self.config.model_path,
            self.config.api_base_url,
            self.config.llama_server,
            self.config.llama_port,
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
            "job %s: %s -> %s (%s cues)",
            job_id,
            job.get("sourceLanguage"),
            job.get("targetLanguage"),
            len(claim["source"]["segments"]),
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
        except (JobFailure, TranslationError) as error:
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
    verify_model_file(config.model_path)

    worker = Worker(config)
    signal.signal(signal.SIGTERM, lambda *_: worker.request_stop("SIGTERM"))
    signal.signal(signal.SIGINT, lambda *_: worker.request_stop("SIGINT"))
    return worker.run()


if __name__ == "__main__":
    raise SystemExit(main())
