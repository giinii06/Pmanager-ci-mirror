from __future__ import annotations

import logging
import warnings
import signal
import sys
import threading
import time
from pathlib import Path
from typing import Any

from .client import FatalError, LeaseLost, WorkerClient
from .config import Config, load_config
from .device import detect_device
from .pipeline import Heartbeat, Pipeline

log = logging.getLogger("asr_worker")

REQUIRED_FILES = ("config.json", "model.safetensors")


def verify_model_dir(path: str, label: str) -> None:
    root = Path(path)
    if not root.is_dir():
        raise SystemExit(
            f"{label} directory {path} is missing. Run the asr-model-init service first "
            "(docker compose --env-file .env --env-file .env.asr "
            "-f compose.yaml -f compose.asr.models.yaml run --rm asr-model-init)."
        )
    missing = [name for name in REQUIRED_FILES if not (root / name).is_file()]
    if missing:
        raise SystemExit(f"{label} directory {path} is incomplete: missing {', '.join(missing)}.")


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
            heartbeat.lost.set()
            heartbeat._terminate()

    def run(self) -> int:
        device = detect_device(self.config.device)
        log.info(
            "worker %s ready: device=%s model=%s aligner=%s api=%s",
            self.config.worker_id,
            device,
            self.config.model_dir,
            self.config.aligner_dir,
            self.config.api_base_url,
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

            self._run_job(claim)

        return 0

    def _run_job(self, claim: dict[str, Any]) -> None:
        job = claim["job"]
        media = claim["media"]
        job_id = job["id"]
        log.info("job %s: %s (%s)", job_id, media.get("filename"), job.get("stage"))

        heartbeat = Heartbeat(self.client, job_id, self.config.worker_id, self.config.lease_ms)
        self.current = heartbeat
        heartbeat.start()
        started = time.monotonic()
        try:
            self.pipeline.process(job, media, heartbeat)
            log.info("job %s finished in %.1fs", job_id, time.monotonic() - started)
        except LeaseLost:
            log.warning("job %s: lease lost, leaving it to the queue", job_id)
        except FatalError:
            raise
        except Exception as error:  # noqa: BLE001 - report every failure to the API
            log.exception("job %s failed", job_id)
            message = f"{type(error).__name__}: {error}"
            try:
                self.client.fail(job_id, self.config.worker_id, message)
            except LeaseLost:
                log.warning("job %s: lease was already gone", job_id)
            except Exception:  # noqa: BLE001 - the loop must survive a reporting failure
                log.exception("could not report the failure for job %s", job_id)
        finally:
            heartbeat.stop()
            self.current = None


def main() -> int:
    warnings.filterwarnings("ignore", category=SyntaxWarning)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    config = load_config()
    verify_model_dir(config.model_dir, "ASR model")
    verify_model_dir(config.aligner_dir, "Aligner model")

    worker = Worker(config)
    signal.signal(signal.SIGTERM, lambda *_: worker.request_stop("SIGTERM"))
    signal.signal(signal.SIGINT, lambda *_: worker.request_stop("SIGINT"))
    return worker.run()


if __name__ == "__main__":
    raise SystemExit(main())
