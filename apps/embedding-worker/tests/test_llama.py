from __future__ import annotations

import json

import pytest

from embedding_worker import llama as llama_module
from embedding_worker.client import JobFailure
from embedding_worker.config import load_config
from embedding_worker.llama import LlamaServer


def make_config(tmp_path, **env: str):
    base = {
        "EMBEDDING_WORKER_TOKEN": "token-token-token",
        "EMBEDDING_MODEL_PATH": str(tmp_path / "model.gguf"),
    }
    base.update(env)
    return load_config(base)


class FakeResponse:
    def __init__(self, payload: dict):
        self.payload = payload

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_: object) -> bool:
        return False


def respond_with(monkeypatch, payload: dict) -> None:
    monkeypatch.setattr(
        llama_module.urllib.request,
        "urlopen",
        lambda request, timeout: FakeResponse(payload),
    )


def test_embed_returns_the_vectors_in_input_order_and_unit_length(monkeypatch, tmp_path) -> None:
    respond_with(
        monkeypatch,
        {
            "data": [
                {"index": 1, "embedding": [0.0, 0.0, 4.0]},
                {"index": 0, "embedding": [3.0, 4.0, 0.0]},
            ]
        },
    )

    vectors = LlamaServer(make_config(tmp_path)).embed(["first", "second"], 3)

    assert vectors[0] == pytest.approx([0.6, 0.8, 0.0])
    assert vectors[1] == pytest.approx([0.0, 0.0, 1.0])


def test_embed_refuses_a_vector_of_the_wrong_dimension(monkeypatch, tmp_path) -> None:
    respond_with(monkeypatch, {"data": [{"index": 0, "embedding": [1.0, 0.0]}]})

    with pytest.raises(JobFailure, match="2 dimensions, expected 3"):
        LlamaServer(make_config(tmp_path)).embed(["first"], 3)


def test_embed_reports_a_response_without_data(monkeypatch, tmp_path) -> None:
    respond_with(monkeypatch, {"error": "model does not support embeddings"})

    with pytest.raises(JobFailure, match="returned no embedding"):
        LlamaServer(make_config(tmp_path)).embed(["first"], 3)
