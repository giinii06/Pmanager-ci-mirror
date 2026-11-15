"""Turns a search box into the three PE-AV query vectors.

Runs on the CPU so it never competes for the card with ASR, translation,
embedding or the scene indexer. The text tower is small next to the video
tower, and a query costs tens of milliseconds here.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .model import encode_text, encode_vector, load_model

log = logging.getLogger("scene_worker.query")

MAX_BODY = 8 * 1024


class Encoder:
    def __init__(self, model_id: str, cache_dir: str):
        import gc

        import torch
        from transformers import PeAudioVideoProcessor

        torch.set_num_threads(max(1, (os.cpu_count() or 4) - 1))
        self.processor = PeAudioVideoProcessor.from_pretrained(model_id, cache_dir=cache_dir)
        # bfloat16 keeps the whole checkpoint at 4.1 GB while it loads. The
        # encoders are dropped straight after: a query only needs the text
        # tower and the three heads, about 0.6 GB.
        self.model = load_model(model_id, cache_dir, device="cpu", dtype=torch.bfloat16)
        self.model.audio_video_encoder = None
        self.model.video_model.video_encoder = None
        self.model.audio_model.audio_encoder = None
        gc.collect()
        self.lock = threading.Lock()
        log.info("text tower ready on cpu")

    def encode(self, text: str) -> dict[str, Any]:
        with self.lock:
            visual, audio, joint = encode_text(
                self.model, self.processor, text, device="cpu"
            )
        return {
            "visual": encode_vector(visual[0].float().tolist()),
            "audio": encode_vector(audio[0].float().tolist()),
            "av": encode_vector(joint[0].float().tolist()),
            "dimensions": int(visual.shape[-1]),
        }


def make_handler(encoder: Encoder) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib name
            log.debug("%s " + format, self.address_string(), *args)

        def _send(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - stdlib name
            if self.path == "/health":
                self._send(200, {"ok": True})
                return
            self._send(404, {"error": "not_found"})

        def do_POST(self) -> None:  # noqa: N802 - stdlib name
            if self.path != "/encode":
                self._send(404, {"error": "not_found"})
                return
            length = int(self.headers.get("content-length") or 0)
            if length <= 0 or length > MAX_BODY:
                self._send(400, {"error": "bad_length"})
                return
            try:
                body = json.loads(self.rfile.read(length))
                text = str(body.get("text", "")).strip()
            except (ValueError, UnicodeDecodeError):
                self._send(400, {"error": "bad_json"})
                return
            if not text:
                self._send(400, {"error": "empty_text"})
                return
            try:
                self._send(200, encoder.encode(text[:500]))
            except Exception as error:  # noqa: BLE001 - the caller needs a reason
                log.exception("encode failed")
                self._send(500, {"error": "encode_failed", "message": str(error)[:300]})

    return Handler


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    model_id = os.environ.get("SCENE_MODEL_ID", "facebook/pe-av-base-16-frame")
    cache_dir = os.environ.get("SCENE_MODEL_DIR", "/models/scene")
    port = int(os.environ.get("SCENE_QUERY_PORT", "8091"))

    encoder = Encoder(model_id, cache_dir)
    server = ThreadingHTTPServer(("0.0.0.0", port), make_handler(encoder))
    log.info("scene query listening on %d", port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
