from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from typing import Any

log = logging.getLogger(__name__)


class FatalError(RuntimeError):
    """The worker cannot continue: bad token, bad configuration, or a bug."""


class LeaseLost(RuntimeError):
    """The API handed this job to another worker."""


class WorkerClient:
    def __init__(self, base_url: str, token: str, timeout: float = 60.0, attempts: int = 3):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.attempts = attempts

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        data = json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            method="POST",
            headers={
                "content-type": "application/json",
                "x-worker-token": self.token,
            },
        )

        last_error: Exception | None = None
        for attempt in range(self.attempts):
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    raw = response.read()
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as error:
                detail = error.read().decode("utf-8", "replace")
                if error.code == 401:
                    raise FatalError("The API rejected ASR_WORKER_TOKEN.") from error
                if error.code == 409:
                    raise LeaseLost(detail or "lease lost") from error
                if error.code >= 500:
                    last_error = error
                else:
                    raise FatalError(f"API {path} failed with {error.code}: {detail}") from error
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                last_error = error

            delay = min(8.0, 0.5 * (2**attempt))
            log.warning("POST %s failed (%s), retrying in %.1fs", path, last_error, delay)
            time.sleep(delay)

        raise FatalError(f"API {path} is unreachable: {last_error}")

    def claim(self, owner: str, lease_ms: int) -> dict[str, Any] | None:
        payload = self._post("/worker/asr/claim", {"owner": owner, "leaseMs": lease_ms})
        return payload if payload.get("job") else None

    def heartbeat(self, job_id: str, owner: str) -> None:
        self._post(f"/worker/asr/jobs/{job_id}/heartbeat", {"owner": owner})

    def progress(self, job_id: str, owner: str, state: str, stage: str, progress: float) -> None:
        self._post(
            f"/worker/asr/jobs/{job_id}/progress",
            {
                "owner": owner,
                "state": state,
                "stage": stage,
                "progress": round(max(0.0, min(99.0, progress)), 1),
            },
        )

    def complete(self, job_id: str, owner: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/worker/asr/jobs/{job_id}/complete", {"owner": owner, **payload})

    def fail(self, job_id: str, owner: str, message: str) -> dict[str, Any]:
        return self._post(f"/worker/asr/jobs/{job_id}/fail", {"owner": owner, "message": message})
