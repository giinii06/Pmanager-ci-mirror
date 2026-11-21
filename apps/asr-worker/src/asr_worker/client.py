from __future__ import annotations

import json
import secrets
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
        self._gpu_lease_tokens: dict[str, str] = {}

    def _post(
        self,
        path: str,
        body: dict[str, Any],
        *,
        timeout: float | None = None,
        attempts: int | None = None,
    ) -> dict[str, Any]:
        timeout = self.timeout if timeout is None else timeout
        attempts = self.attempts if attempts is None else attempts
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
        for attempt in range(attempts):
            try:
                with urllib.request.urlopen(request, timeout=timeout) as response:
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

            if attempt + 1 == attempts:
                break
            delay = min(8.0, 0.5 * (2**attempt))
            log.warning("POST %s failed (%s), retrying in %.1fs", path, last_error, delay)
            time.sleep(delay)

        raise FatalError(f"API {path} is unreachable: {last_error}")

    def claim(self, owner: str, lease_ms: int) -> dict[str, Any] | None:
        payload = self._post("/worker/asr/claim", {"owner": owner, "leaseMs": lease_ms})
        return payload if payload.get("job") else None

    def heartbeat(self, job_id: str, owner: str, *, timeout: float | None = None) -> None:
        """One attempt on the caller's deadline: a retry can outlive the lease."""
        self._post(
            f"/worker/asr/jobs/{job_id}/heartbeat",
            {"owner": owner},
            timeout=timeout,
            attempts=1,
        )

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
        # The API rejects a message longer than 2000 characters, and a rejected
        # failure report leaves the job leased until the lease expires.
        return self._post(
            f"/worker/asr/jobs/{job_id}/fail", {"owner": owner, "message": message[:2000]}
        )

    def gpu_acquire(self, owner: str, task_kind: str, lease_ms: int) -> bool:
        # A new nonce for each acquisition; the HTTP retry loop reuses it.
        payload = self._post(
            "/worker/gpu/acquire",
            {
                "owner": owner,
                "taskKind": task_kind,
                "leaseMs": lease_ms,
                "acquisitionId": secrets.token_urlsafe(24),
            },
        )
        if not payload.get("acquired"):
            return False
        lease_token = payload.get("leaseToken")
        if not isinstance(lease_token, str) or len(lease_token) != 43:
            raise FatalError("GPU lease response has no valid capability.")
        self._gpu_lease_tokens[owner] = lease_token
        return True

    def gpu_heartbeat(self, owner: str, *, timeout: float | None = None) -> None:
        """One attempt on the caller's deadline: a retry can outlive the lease."""
        lease_token = self._gpu_lease_tokens.get(owner)
        if lease_token is None:
            raise LeaseLost("GPU lease has no local capability.")
        self._post(
            "/worker/gpu/heartbeat",
            {"owner": owner, "leaseToken": lease_token},
            timeout=timeout,
            attempts=1,
        )

    def gpu_release(self, owner: str) -> None:
        lease_token = self._gpu_lease_tokens.get(owner)
        if lease_token is None:
            return
        try:
            self._post("/worker/gpu/release", {"owner": owner, "leaseToken": lease_token})
        finally:
            self._gpu_lease_tokens.pop(owner, None)
