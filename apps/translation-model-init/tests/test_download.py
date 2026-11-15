"""Behaviour tests for the translation model downloader.

The transfer is injected, so nothing here reaches the network or the Hub.
"""

from __future__ import annotations

import hashlib
import json
import sys
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


def make_settings(tmp_path: Path, **overrides) -> dm.Settings:
    values = {
        "repo_id": REPO,
        "filename": FILENAME,
        "revision": REVISION,
        "sha256": MODEL_SHA,
        "quantization": "Q4_K_M",
        "models_dir": tmp_path / "models",
    }
    values.update(overrides)
    return dm.Settings(**values)


def final_path(settings: dm.Settings) -> Path:
    return settings.models_dir / "translation" / settings.filename


def fake_download(payload: bytes = MODEL_BYTES, calls: list | None = None):
    def fetch(*, repo_id, filename, revision, token, local_dir):
        if calls is not None:
            calls.append((repo_id, filename, revision, token))
        path = Path(local_dir) / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        return str(path)

    return fetch


def test_second_run_does_not_download_again(tmp_path):
    settings = make_settings(tmp_path)
    calls: list = []

    first = dm.ensure_model(settings, download=fake_download(calls=calls))
    second = dm.ensure_model(settings, download=fake_download(calls=calls))

    assert first == second == final_path(settings)
    assert first.read_bytes() == MODEL_BYTES
    assert len(calls) == 1


def test_untrusted_existing_file_is_replaced_and_archived(tmp_path):
    settings = make_settings(tmp_path)
    stale = final_path(settings)
    stale.parent.mkdir(parents=True)
    stale.write_bytes(b"GGUF" + b"an older build")

    dm.ensure_model(settings, download=fake_download())

    assert final_path(settings).read_bytes() == MODEL_BYTES
    archived = list((settings.models_dir / "translation" / ".archive").iterdir())
    assert len(archived) == 1
    assert archived[0].read_bytes() == b"GGUF" + b"an older build"


def test_file_with_the_right_digest_but_no_gguf_magic_is_refused(tmp_path):
    error_page = b"<html>rate limited</html>"
    settings = make_settings(tmp_path, sha256=hashlib.sha256(error_page).hexdigest())

    with pytest.raises(dm.InitError, match="not a GGUF file"):
        dm.ensure_model(settings, download=fake_download(error_page))

    assert not final_path(settings).exists()


def test_download_failure_is_reported_and_leaves_nothing_behind(tmp_path):
    settings = make_settings(tmp_path)

    def gated(**kwargs):
        raise RuntimeError("403 Client Error: gated repository")

    with pytest.raises(dm.InitError, match="HF_TOKEN"):
        dm.ensure_model(settings, download=gated)

    staging = settings.models_dir / "translation" / ".staging"
    assert not list(staging.iterdir())
    assert not final_path(settings).exists()


def test_staging_directory_is_removed_after_a_successful_download(tmp_path):
    settings = make_settings(tmp_path)

    dm.ensure_model(settings, download=fake_download())

    staging = settings.models_dir / "translation" / ".staging"
    assert not list(staging.iterdir())


def test_manifest_records_the_verified_artifact(tmp_path):
    settings = make_settings(tmp_path)

    dm.ensure_model(settings, download=fake_download())

    manifest = json.loads((settings.models_dir / "translation" / "model-manifest.json").read_text())
    assert manifest["repo"] == REPO
    assert manifest["revision"] == REVISION
    assert manifest["filename"] == FILENAME
    assert manifest["sha256"] == MODEL_SHA
    assert manifest["size"] == len(MODEL_BYTES)
    assert manifest["quantization"] == "Q4_K_M"
    assert manifest["downloaded_at"].endswith("+00:00")


def test_publish_keeps_the_previous_file(tmp_path):
    settings = make_settings(tmp_path)
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
    settings = make_settings(tmp_path)
    monkeypatch.setattr(dm, "REQUIRED_FREE_GB", 12.0)
    monkeypatch.setattr(dm, "disk_free_gb", lambda path: 1.5)
    calls: list = []

    with pytest.raises(dm.InitError, match="only 1.5 GB free"):
        dm.ensure_model(settings, download=fake_download(calls=calls))

    assert calls == []


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


def test_main_exits_non_zero_with_a_readable_error(capsys):
    code = dm.main({"TRANSLATION_MODEL_REVISION": "main", "TRANSLATION_MODEL_SHA256": MODEL_SHA})

    assert code == 1
    assert "ERROR" in capsys.readouterr().err
