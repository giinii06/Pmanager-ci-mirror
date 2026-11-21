from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
WORKERS = ("asr", "translation", "embedding", "scene")
CAPABILITY = "Z" * 43


def make_client(kind: str):
    path = ROOT / "apps" / f"{kind}-worker" / "src" / f"{kind}_worker" / "client.py"
    spec = importlib.util.spec_from_file_location(f"gpu_client_{kind}", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.WorkerClient("http://127.0.0.1:8787", "fake-worker-token"), module


@pytest.mark.parametrize("kind", WORKERS)
def test_gpu_capability_is_forwarded_and_cleared(kind: str) -> None:
    client, _ = make_client(kind)
    requests: list[tuple[str, dict[str, Any], dict[str, Any]]] = []

    def fake_post(path: str, body: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
        requests.append((path, body, kwargs))
        if path.endswith("/acquire"):
            return {"acquired": True, "leaseToken": CAPABILITY}
        return {}

    client._post = fake_post
    assert client.gpu_acquire("worker-1", kind, 120_000) is True
    acquire = requests[0][1]
    assert acquire["owner"] == "worker-1"
    assert acquire["taskKind"] == kind
    assert len(acquire["acquisitionId"]) >= 24

    client.gpu_heartbeat("worker-1", timeout=1.0)
    assert requests[1][1] == {"owner": "worker-1", "leaseToken": CAPABILITY}
    assert requests[1][2] == {"timeout": 1.0, "attempts": 1}

    client.gpu_release("worker-1")
    assert requests[2][1] == {"owner": "worker-1", "leaseToken": CAPABILITY}
    assert client._gpu_lease_tokens == {}


@pytest.mark.parametrize("kind", WORKERS)
def test_gpu_unheld_or_malformed_capability_fails_closed(kind: str) -> None:
    client, module = make_client(kind)
    with pytest.raises(module.LeaseLost):
        client.gpu_heartbeat("worker-1")

    client._post = lambda *_args, **_kwargs: {"acquired": True}
    with pytest.raises(module.FatalError):
        client.gpu_acquire("worker-1", kind, 120_000)

    client._post = lambda *_args, **_kwargs: {"acquired": False}
    assert client.gpu_acquire("worker-1", kind, 120_000) is False
    assert client._gpu_lease_tokens == {}
