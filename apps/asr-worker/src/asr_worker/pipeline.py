from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from . import audio
from .client import FatalError, LeaseLost, WorkerClient
from .config import Config
from .jsonio import write_json_atomic
from .subtitles import build_segments, to_srt, to_txt, to_vtt

log = logging.getLogger(__name__)

SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def safe_segment(value: str, limit: int = 40) -> str:
    cleaned = SAFE.sub("-", value.strip()).strip("-")
    return (cleaned or "unknown")[:limit]


class Heartbeat:
    """Keeps the lease alive and tells the pipeline when it is gone.

    Fail-closed: the thread declares the lease lost as soon as it cannot confirm it
    before it expires, instead of retrying until a call happens to return.
    """

    def __init__(
        self,
        client: WorkerClient,
        job_id: str,
        owner: str,
        lease_ms: int,
        *,
        interval: float | None = None,
    ):
        self.client = client
        self.job_id = job_id
        self.owner = owner
        self.lease = lease_ms / 1000.0
        self.interval = max(5.0, lease_ms / 3000) if interval is None else interval
        self.call_timeout = max(1.0, self.lease / 4)  # one renewal inside the lease
        self.lost = threading.Event()
        self.gpu = threading.Event()
        self._process: subprocess.Popen[str] | None = None
        self._stop = threading.Event()
        self._confirmed_until = 0.0  # monotonic; the job lease is known live until here
        self._gpu_until = 0.0  # monotonic; the card is known ours until here
        self._thread = threading.Thread(target=self._loop, name="asr-heartbeat", daemon=True)

    def start(self) -> None:
        self._confirmed_until = time.monotonic() + self.lease  # claim() just granted it
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    def attach(self, process: subprocess.Popen[str]) -> None:
        self._process = process

    def detach(self) -> None:
        self._process = None

    def hold_gpu(self) -> None:
        self._gpu_until = time.monotonic() + self.lease  # the acquire just granted it
        self.gpu.set()

    def drop_gpu(self) -> None:
        self._gpu_until = 0.0
        self.gpu.clear()

    def _loop(self) -> None:
        while not self._stop.wait(self._next_wait()):
            if self._expired():
                self._lose("the lease expired before a heartbeat was confirmed")
                return
            self._beat()

    def _next_wait(self) -> float:
        """Wake on the interval, but never sleep past an unconfirmed deadline: that
        instant is when the card may already belong to someone else."""
        deadlines = [self._confirmed_until]
        if self.gpu.is_set():
            deadlines.append(self._gpu_until)
        return max(0.0, min(self.interval, min(deadlines) - time.monotonic()))

    def _expired(self) -> bool:
        now = time.monotonic()
        return now >= self._confirmed_until or (self.gpu.is_set() and now >= self._gpu_until)

    def _beat(self) -> None:
        now = time.monotonic()
        try:
            self.client.heartbeat(
                self.job_id,
                self.owner,
                timeout=min(self.call_timeout, max(0.1, self._confirmed_until - now)),
            )
            self._confirmed_until = time.monotonic() + self.lease
        except LeaseLost:
            self._lose(f"lease lost for {self.job_id}")
            return
        except FatalError as error:
            self._lose(f"heartbeat failed: {error}")
            return
        except Exception as error:  # noqa: BLE001 - transient while the lease still lives
            log.warning("heartbeat error: %s", error)
            return  # the deadline decides, not this exception
        if not self.gpu.is_set():
            return
        now = time.monotonic()  # the job call above may have taken a while
        try:
            self.client.gpu_heartbeat(
                self.owner, timeout=min(self.call_timeout, max(0.1, self._gpu_until - now))
            )
            self._gpu_until = time.monotonic() + self.lease
        except LeaseLost:
            self._lose(f"GPU lease lost for {self.job_id}")
        except FatalError as error:
            self._lose(f"GPU heartbeat failed: {error}")
        except Exception as error:  # noqa: BLE001 - the deadline decides
            log.warning("GPU heartbeat error: %s", error)

    def _lose(self, message: str) -> None:
        log.warning("%s, stopping the pipeline", message)
        self.lost.set()
        self._terminate()

    def _terminate(self) -> None:
        process = self._process
        if process and process.poll() is None:
            process.terminate()


class Pipeline:
    def __init__(self, config: Config, client: WorkerClient):
        self.config = config
        self.client = client
        self.owner = config.worker_id

    def process(self, job: dict[str, Any], media: dict[str, Any], heartbeat: Heartbeat) -> None:
        job_id = job["id"]
        asset_id = job["assetId"]
        file_version = int(job["fileVersion"])

        mismatched = [
            name
            for name, job_value, worker_value in (
                ("ASR_MODEL_REVISION", job.get("modelRevision"), self.config.model_revision),
                ("ALIGN_MODEL_REVISION", job.get("alignerRevision"), self.config.aligner_revision),
                ("ASR_PIPELINE_VERSION", job.get("pipelineVersion"), self.config.pipeline_version),
            )
            if job_value != worker_value
        ]
        if mismatched:
            raise RuntimeError(
                "The API and the worker disagree on " + ", ".join(mismatched) + ". "
                "Use the same values on both sides and restart them."
            )

        source = audio.resolve_media(self.config.media_root, media["path"])
        if not audio.has_audio_stream(source):
            raise RuntimeError("This video has no audio track.")

        workdir = Path(tempfile.mkdtemp(prefix=f"asr-{asset_id}-", dir=self.config.temp_dir or None))
        try:
            self._report(job_id, "transcribing", "extracting", 2)
            wav = workdir / "audio.wav"
            audio.extract_audio(source, wav)
            duration_ms = audio.probe_duration_ms(wav)

            self._report(job_id, "transcribing", "chunking", 6)
            silences = audio.detect_silences(wav)
            plan = audio.plan_chunks(
                duration_ms,
                silences,
                min_ms=self.config.min_chunk_ms,
                max_ms=self.config.max_chunk_ms,
            )
            if not plan:
                raise RuntimeError("No speech window could be planned for this file.")

            chunks: list[dict[str, Any]] = []
            for index, (start_ms, end_ms) in enumerate(plan):
                chunk_path = workdir / f"chunk-{index:04d}.wav"
                audio.slice_wav(wav, start_ms, end_ms, chunk_path)
                chunks.append(
                    {
                        "index": index,
                        "start_ms": start_ms,
                        "end_ms": end_ms,
                        "wav": str(chunk_path),
                    }
                )

            plan_path = workdir / "chunks.json"
            write_json_atomic(
                plan_path,
                {
                    "asset_id": asset_id,
                    "duration_ms": duration_ms,
                    "model_id": self.config.model_id,
                    "model_revision": self.config.model_revision,
                    "chunks": chunks,
                },
            )

            asr_path = workdir / "asr.json"
            self._run_stage(
                [
                    "transcribe",
                    "--input",
                    str(plan_path),
                    "--output",
                    str(asr_path),
                    "--model-dir",
                    self.config.model_dir,
                    "--device",
                    self._device(),
                    "--language",
                    self.config.language,
                ],
                heartbeat,
                job_id,
                state="transcribing",
                stage="transcribing",
                low=10.0,
                high=55.0,
            )

            aligned_path = workdir / "aligned.json"
            self._run_stage(
                [
                    "align",
                    "--input",
                    str(asr_path),
                    "--output",
                    str(aligned_path),
                    "--aligner-dir",
                    self.config.aligner_dir,
                    "--device",
                    self._device(),
                    "--language",
                    self.config.language,
                ],
                heartbeat,
                job_id,
                state="aligning",
                stage="aligning",
                low=55.0,
                high=85.0,
            )

            self._report(job_id, "writing", "writing", 88)
            aligned = json.loads(aligned_path.read_text(encoding="utf-8"))
            self._write_results(job_id, aligned, duration_ms, file_version, asset_id)
        finally:
            if not self.config.keep_workdir:
                _remove_tree(workdir)

    def _device(self) -> str:
        from .device import detect_device

        return detect_device(self.config.device)

    def _report(self, job_id: str, state: str, stage: str, progress: float) -> None:
        self.client.progress(job_id, self.owner, state, stage, progress)

    def _acquire_gpu(self, heartbeat: Heartbeat) -> bool:
        deadline = time.monotonic() + self.config.gpu_wait_seconds
        while not heartbeat.lost.is_set():
            if self.client.gpu_acquire(self.owner, "asr", self.config.lease_ms):
                return True
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            log.info("GPU is busy, retrying in %.0fs", min(5.0, remaining))
            heartbeat.lost.wait(min(5.0, remaining))
        raise LeaseLost("lease lost while waiting for the GPU")

    def _run_stage(
        self,
        args: list[str],
        heartbeat: Heartbeat,
        job_id: str,
        *,
        state: str,
        stage: str,
        low: float,
        high: float,
    ) -> None:
        if heartbeat.lost.is_set():
            raise LeaseLost("lease lost before the stage started")

        # The stage process loads a model onto the card, so it holds the shared
        # GPU lease for as long as the process lives. Releasing before the
        # process exits would let a translation start on the same card.
        if not self._acquire_gpu(heartbeat):
            raise RuntimeError("GPU is busy with another job.")
        heartbeat.hold_gpu()

        log_handle, log_name = tempfile.mkstemp(prefix="asr-stage-", suffix=".log")
        os.close(log_handle)
        log_path = Path(log_name)
        process: subprocess.Popen[str] | None = None
        try:
            with log_path.open("w", encoding="utf-8") as log_stream:
                process = subprocess.Popen(
                    [sys.executable, "-m", "asr_worker.stage", *args],
                    stdout=subprocess.PIPE,
                    stderr=log_stream,
                    text=True,
                    bufsize=1,
                )
                heartbeat.attach(process)
                last_report = 0.0
                try:
                    assert process.stdout is not None
                    for line in process.stdout:
                        line = line.strip()
                        if not line.startswith("PROGRESS "):
                            continue
                        try:
                            fraction = float(line.split(" ", 1)[1])
                        except ValueError:
                            continue
                        now = time.monotonic()
                        if now - last_report < 1.0:
                            continue
                        last_report = now
                        self._report(job_id, state, stage, low + (high - low) * fraction)

                    code = process.wait()
                finally:
                    heartbeat.detach()

                if heartbeat.lost.is_set():
                    raise LeaseLost("lease lost while a stage was running")
                if code != 0:
                    tail = _tail(log_path)
                    raise RuntimeError(f"{args[0]} stage failed: {tail}")
        finally:
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=30)
            heartbeat.drop_gpu()
            try:
                self.client.gpu_release(self.owner)
            except Exception as error:  # noqa: BLE001 - the lease expires on its own
                log.warning("could not release the GPU lease: %s", error)
            log_path.unlink(missing_ok=True)

    def _write_results(
        self,
        job_id: str,
        aligned: dict[str, Any],
        duration_ms: int,
        file_version: int,
        asset_id: str,
    ) -> None:
        chunks = aligned.get("chunks", [])
        segments = build_segments(chunks)
        if not segments:
            raise RuntimeError("No subtitle line could be placed on the timeline.")

        plain_text = "\n".join(
            str(chunk.get("text", "")).strip()
            for chunk in chunks
            if str(chunk.get("text", "")).strip()
        )
        key = "_".join(
            safe_segment(part)
            for part in (
                self.config.model_revision,
                self.config.aligner_revision,
                self.config.pipeline_version,
            )
        )
        relative = f"{safe_segment(asset_id, 32)}/{file_version}/{key}"
        target = Path(self.config.result_dir) / relative
        target.mkdir(parents=True, exist_ok=True)

        transcript = {
            "assetId": asset_id,
            "fileVersion": file_version,
            "language": self.config.language,
            "modelId": self.config.model_id,
            "modelRevision": self.config.model_revision,
            "alignerId": self.config.aligner_id,
            "alignerRevision": self.config.aligner_revision,
            "pipelineVersion": self.config.pipeline_version,
            "device": aligned.get("device"),
            "durationMs": duration_ms,
            "createdAt": int(time.time() * 1000),
            "segments": [segment.as_dict() for segment in segments],
            "chunks": chunks,
        }

        write_json_atomic(target / "transcript.json", transcript)
        _write_text_atomic(target / "subtitles.vtt", to_vtt(segments))
        _write_text_atomic(target / "subtitles.srt", to_srt(segments))
        _write_text_atomic(target / "transcript.txt", to_txt(segments))

        self.client.complete(
            job_id,
            self.owner,
            {
                "transcriptId": f"{safe_segment(asset_id, 32)}-{uuid.uuid4().hex[:12]}",
                "resultDir": relative,
                "plainText": plain_text,
                "language": self.config.language,
                "segments": [
                    {"startMs": segment.start_ms, "endMs": segment.end_ms, "text": segment.text}
                    for segment in segments
                ],
            },
        )


def _write_text_atomic(path: Path, text: str) -> None:
    handle, temp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(text)
        os.replace(temp_name, path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise


def _tail(path: Path, lines: int = 6) -> str:
    try:
        content = path.read_text(encoding="utf-8", errors="replace").strip().splitlines()
    except OSError:
        return "no log output"
    return " | ".join(content[-lines:]) or "no log output"


def _remove_tree(path: Path) -> None:
    if not path.exists():
        return
    for child in sorted(path.rglob("*"), reverse=True):
        try:
            if child.is_dir():
                child.rmdir()
            else:
                child.unlink()
        except OSError:
            pass
    try:
        path.rmdir()
    except OSError:
        pass
