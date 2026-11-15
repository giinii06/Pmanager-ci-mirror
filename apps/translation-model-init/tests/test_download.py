"""Behaviour tests for the translation model downloader.

Every test serves the file from a local directory over a file:// URL, or
injects its own opener, so nothing here reaches the network.
"""

from __future__ import annotations

import hashlib
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import download_model as dm

REVISION = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b"
REPO = "IndexTeam/Index-Translate-9B-GGUF"
FILENAME = "Index-Translate-9B.Q4_K_M.gguf"

MODEL_BYTES = b"GGUF" + b"\x03\x00\x00\x00" + bytes(range(64))
MODEL_SHA = hashlib.sha256(MODEL_BYTES).hexdigest()


@pytest.fixture(autouse=True)
def ignore_host_free_space(monkeypatch):
    """The guard has its own test; the rest must not depend on the machine."""
    monkeypatch.setattr(dm, "REQUIRED_FREE_GB", 0.0)


def serve(tmp_path: Path, payload: bytes = MODEL_BYTES, *, filename: str = FILENAME) -> Path:
    """Writes payload where the Hugging Face URL layout expects it, returns the base URL."""
    root = tmp_path / "hub"
    path = root / REPO / "resolve" / REVISION / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return root


def make_settings(tmp_path: Path, base_url: Path, **overrides) -> dm.Settings:
    values = {
        "repo_id": REPO,
        "filename": FILENAME,
        "revision": REVISION,
        "sha256": MODEL_SHA,
        "quantization": "Q4_K_M",
        "models_dir": tmp_path / "models",
        "base_url": base_url.as_uri(),
    }
    values.update(overrides)
    return dm.Settings(**values)


def final_path(settings: dm.Settings) -> Path:
    return settings.models_dir / "translation" / settings.filename


class CountingOpener:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, request):
        self.calls += 1
        return urllib.request.urlopen(request)


class FakeResponse:
    def __init__(self, payload: bytes, declared: int | None = None) -> None:
        self._payload = payload
        self.headers = {"Content-Length": str(len(payload) if declared is None else declared)}

    def read(self, size: int) -> bytes:
        block, self._payload = self._payload[:size], self._payload[size:]
        return block

    def __enter__(self):
        return self

    def __exit__(self, *exception) -> bool:
        return False


def test_second_run_does_not_download_again(tmp_path):
    settings = make_settings(tmp_path, serve(tmp_path))
    opener = CountingOpener()

    first = dm.ensure_model(settings, opener=opener)
    second = dm.ensure_model(settings, opener=opener)

    assert first == second == final_path(settings)
    assert first.read_bytes() == MODEL_BYTES
    assert opener.calls == 1


def test_untrusted_existing_file_is_replaced_and_archived(tmp_path):
    settings = make_settings(tmp_path, serve(tmp_path))
    stale = final_path(settings)
    stale.parent.mkdir(parents=True)
    stale.write_bytes(b"GGUF" + b"an older build")

    dm.ensure_model(settings, opener=CountingOpener())

    assert final_path(settings).read_bytes() == MODEL_BYTES
    archived = list((settings.models_dir / "translation" / ".archive").iterdir())
    assert len(archived) == 1
    assert archived[0].read_bytes() == b"GGUF" + b"an older build"


def test_file_with_the_right_digest_but_no_gguf_magic_is_refused(tmp_path):
    error_page = b"<html>rate limited</html>"
    settings = make_settings(
        tmp_path,
        serve(tmp_path, error_page),
        sha256=hashlib.sha256(error_page).hexdigest(),
    )

    with pytest.raises(dm.InitError, match="not a GGUF file"):
        dm.ensure_model(settings, opener=CountingOpener())

    assert not final_path(settings).exists()


def test_retries_a_transient_failure_then_succeeds(tmp_path):
    settings = make_settings(tmp_path, serve(tmp_path))
    real = urllib.request.urlopen
    attempts = []

    def flaky(request):
        attempts.append(request)
        if len(attempts) < 3:
            raise urllib.error.URLError("connection reset")
        return real(request)

    waits: list[float] = []
    dm.ensure_model(settings, opener=flaky, sleep=waits.append)

    assert len(attempts) == 3
    assert waits == [2.0, 4.0]
    assert final_path(settings).read_bytes() == MODEL_BYTES


def test_gives_up_after_the_last_retry_and_leaves_nothing_behind(tmp_path):
    settings = make_settings(tmp_path, serve(tmp_path))

    def dead(request):
        raise urllib.error.URLError("no route to host")

    with pytest.raises(dm.InitError, match="after 4 attempts"):
        dm.ensure_model(settings, opener=dead, sleep=lambda seconds: None)

    staging = settings.models_dir / "translation" / ".staging"
    assert not list(staging.iterdir())
    assert not final_path(settings).exists()


def test_short_stream_is_retried_then_refused(tmp_path):
    settings = make_settings(tmp_path, serve(tmp_path))
    calls = []

    def truncated(request):
        calls.append(request)
        return FakeResponse(MODEL_BYTES[:8], declared=len(MODEL_BYTES))

    with pytest.raises(dm.InitError, match="stream ended after 8 of"):
        dm.download_file(
            settings.url,
            tmp_path / "partial.gguf",
            opener=truncated,
            retries=1,
            sleep=lambda seconds: None,
            log_fn=lambda message: None,
        )

    assert len(calls) == 2


def test_gated_repository_is_not_retried(tmp_path):
    settings = make_settings(tmp_path, serve(tmp_path))
    calls = []

    def forbidden(request):
        calls.append(request)
        raise urllib.error.HTTPError(settings.url, 403, "Forbidden", {}, None)

    with pytest.raises(dm.InitError, match="HF_TOKEN"):
        dm.download_file(
            settings.url,
            tmp_path / "gated.gguf",
            opener=forbidden,
            sleep=lambda seconds: None,
            log_fn=lambda message: None,
        )

    assert len(calls) == 1


def test_manifest_records_the_verified_artifact(tmp_path):
    settings = make_settings(tmp_path, serve(tmp_path))

    dm.ensure_model(settings, opener=CountingOpener())

    manifest = json.loads((settings.models_dir / "translation" / "model-manifest.json").read_text())
    assert manifest["repo"] == REPO
    assert manifest["revision"] == REVISION
    assert manifest["filename"] == FILENAME
    assert manifest["sha256"] == MODEL_SHA
    assert manifest["size"] == len(MODEL_BYTES)
    assert manifest["quantization"] == "Q4_K_M"
    assert manifest["downloaded_at"].endswith("+00:00")


def test_publish_keeps_the_previous_file(tmp_path):
    settings = make_settings(tmp_path, serve(tmp_path))
    paths = dm.Paths.of(settings)
    paths.final.parent.mkdir(parents=True)
    paths.final.write_bytes(b"GGUF" + b"previous")
    staged = paths.staging / "incoming.part"
    staged.parent.mkdir(parents=True)
    staged.write_bytes(MODEL_BYTES)

    archived = dm.publish(staged, paths)

    assert paths.final.read_bytes() == MODEL_BYTES
    assert archived is not None
    assert archived.read_bytes() == b"GGUF" + b"previous"
    assert not staged.exists()


def test_low_disk_space_is_refused_before_downloading(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, serve(tmp_path))
    monkeypatch.setattr(dm, "REQUIRED_FREE_GB", 12.0)
    monkeypatch.setattr(dm, "disk_free_gb", lambda path: 1.5)

    with pytest.raises(dm.InitError, match="only 1.5 GB free"):
        dm.ensure_model(settings, opener=CountingOpener())


def test_missing_sha_is_refused():
    with pytest.raises(dm.InitError, match="TRANSLATION_MODEL_SHA256"):
        dm.settings_from_env({"TRANSLATION_MODEL_REVISION": REVISION})


def test_blank_revision_is_refused():
    with pytest.raises(dm.InitError, match="TRANSLATION_MODEL_REVISION is empty"):
        dm.settings_from_env({"TRANSLATION_MODEL_SHA256": MODEL_SHA})


def test_floating_revision_needs_the_escape_hatch():
    with pytest.raises(dm.InitError, match="not a 40-character commit SHA"):
        dm.settings_from_env(
            {"TRANSLATION_MODEL_REVISION": "main", "TRANSLATION_MODEL_SHA256": MODEL_SHA}
        )

    allowed = dm.settings_from_env(
        {
            "TRANSLATION_MODEL_REVISION": "main",
            "TRANSLATION_MODEL_SHA256": MODEL_SHA,
            "ALLOW_FLOATING_REVISION": "1",
        }
    )
    assert allowed.revision == "main"


def test_settings_come_from_the_documented_environment():
    settings = dm.settings_from_env(
        {
            "TRANSLATION_MODEL_ID": "someone/else-GGUF",
            "TRANSLATION_MODEL_FILENAME": "Other.F16.gguf",
            "TRANSLATION_MODEL_REVISION": REVISION,
            "TRANSLATION_MODEL_SHA256": MODEL_SHA.upper(),
            "MODELS_DIR": "/srv/models",
            "HF_TOKEN": "hf_example",
        }
    )

    assert settings.repo_id == "someone/else-GGUF"
    assert settings.quantization == "F16"
    assert settings.sha256 == MODEL_SHA
    assert settings.models_dir == Path("/srv/models")
    assert settings.token == "hf_example"
    assert settings.url == (
        f"https://huggingface.co/someone/else-GGUF/resolve/{REVISION}/Other.F16.gguf"
    )


def test_main_exits_non_zero_with_a_readable_error(capsys):
    code = dm.main({"TRANSLATION_MODEL_REVISION": "main", "TRANSLATION_MODEL_SHA256": MODEL_SHA})

    assert code == 1
    assert "ERROR" in capsys.readouterr().err
