"""Durable window prefix for one scene job (spec D-04).

The stage appends each finished window to a JSONL log and fsyncs it before the
manifest names it, so a restart can trust the log over both the manifest and the
database row. A torn tail or a missing thumbnail ends the reusable prefix at
that window, and only the missing units run again.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

MANIFEST_VERSION = 1
CHECKPOINT_EVERY = 5


def fsync_file(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class WindowCheckpoint:
    """Append-only log of finished windows plus an atomically replaced manifest."""

    def __init__(self, root: Path, meta: dict[str, Any], thumbnail_root: Path):
        self.root = root
        self.log = root / "windows.jsonl"
        self.manifest = root / "manifest.json"
        self.meta = meta
        self.total = int(meta["totalUnits"])
        self.thumbnail_root = thumbnail_root
        self._scenes: list[dict[str, Any]] = []
        self._hash = hashlib.sha256()
        self._completed = 0
        self.resumed = 0
        root.mkdir(parents=True, exist_ok=True)
        self._load()

    @property
    def completed(self) -> int:
        return self._completed

    @property
    def scenes(self) -> list[dict[str, Any]]:
        return self._scenes

    @property
    def digest(self) -> str:
        return self._hash.hexdigest()

    def _manifest_matches(self, manifest: dict[str, Any]) -> bool:
        if manifest.get("version") != MANIFEST_VERSION:
            return False
        stored = manifest.get("meta")
        if not isinstance(stored, dict):
            return False
        return all(stored.get(key) == value for key, value in self.meta.items())

    def _load(self) -> None:
        if not self.log.exists():
            return
        try:
            manifest = json.loads(self.manifest.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            manifest = None
        if manifest is None or not self._manifest_matches(manifest):
            # Without a manifest the log cannot be attributed to this model,
            # file version and window plan, so it is not reusable.
            self.log.unlink(missing_ok=True)
            self.manifest.unlink(missing_ok=True)
            return

        raw = self.log.read_bytes()
        good_end = 0
        for line in raw.splitlines(keepends=True):
            if not line.endswith(b"\n"):
                break
            try:
                record = json.loads(line)
            except ValueError:
                break
            if self._completed >= self.total or record.get("seq") != self._completed:
                break
            thumbnail = record.get("thumbnailPath")
            if thumbnail and not (self.thumbnail_root / thumbnail).exists():
                break
            self._hash.update(line)
            self._scenes.append(record)
            self._completed += 1
            good_end += len(line)

        if good_end != len(raw):
            # A crash can leave a half-written line; the next append must start
            # on a clean boundary, so the torn tail is dropped.
            with self.log.open("r+b") as stream:
                stream.truncate(good_end)
                stream.flush()
                os.fsync(stream.fileno())

        self.resumed = self._completed
        if manifest.get("completedUnits") != self._completed or manifest.get("hash") != self.digest:
            # The log is ahead of the manifest (or the manifest is behind after a
            # truncated write); the log wins and the next append rewrites it.
            self._write_manifest()

    def append(self, record: dict[str, Any]) -> bool:
        """Adds one finished window; True when the manifest was rewritten."""
        line = json.dumps(record, separators=(",", ":"), ensure_ascii=False) + "\n"
        with self.log.open("a", encoding="utf-8") as stream:
            stream.write(line)
            stream.flush()
            os.fsync(stream.fileno())
        self._hash.update(line.encode("utf-8"))
        self._scenes.append(record)
        self._completed += 1
        if self._completed % CHECKPOINT_EVERY == 0 or self._completed == self.total:
            self._write_manifest()
            return True
        return False

    def _write_manifest(self) -> None:
        payload = {
            "version": MANIFEST_VERSION,
            "meta": self.meta,
            "completedUnits": self._completed,
            "totalUnits": self.total,
            "hash": self.digest,
        }
        tmp = self.manifest.with_name("manifest.json.tmp")
        with tmp.open("w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, self.manifest)
        fsync_dir(self.root)

    def checkpoint_line(self) -> str:
        """The line the parent forwards to the API after a manifest write."""
        return f"CHECKPOINT {self._completed} {self.total} {self.digest}"
