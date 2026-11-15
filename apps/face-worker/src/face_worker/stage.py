from __future__ import annotations

import argparse
import base64
import json
import logging
import struct
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

log = logging.getLogger("face_worker.stage")

MAX_FRAMES = 900
DETECT_SIZE = 640
CROP_PADDING = 0.4
CROP_SIZE = 160


def plan_sampling(duration_ms: int, sample_ms: int) -> tuple[int, int]:
    """Returns the frame count and the interval actually used.

    A two-hour video at two seconds would be 3600 frames, so the interval grows
    until the count fits. The stored frame time is what the user seeks to, so it
    must be the real one, not the requested one.
    """
    if duration_ms <= 0:
        return 0, sample_ms
    effective = max(250, sample_ms)
    while duration_ms // effective > MAX_FRAMES:
        effective *= 2
    return min(MAX_FRAMES, max(1, duration_ms // effective)), effective


def extract_frames(source: str, dest: Path, sample_ms: int, count: int) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            source,
            "-vf",
            f"fps=1000/{sample_ms},scale={DETECT_SIZE}:-2",
            "-frames:v",
            str(count),
            "-q:v",
            "3",
            str(dest / "%05d.jpg"),
        ],
        check=True,
        capture_output=True,
    )


def encode_vector(vector: Any) -> str:
    values = [float(value) for value in vector]
    norm = sum(value * value for value in values) ** 0.5
    if norm == 0:
        raise RuntimeError("the model returned a zero vector")
    unit = [value / norm for value in values]
    return base64.b64encode(struct.pack(f"<{len(unit)}f", *unit)).decode("ascii")


def crop_face(image: Any, bbox: Any, dest: Path) -> None:
    from PIL import Image

    left, top, right, bottom = (float(value) for value in bbox)
    width = right - left
    height = bottom - top
    pad_x = width * CROP_PADDING
    pad_y = height * CROP_PADDING
    box = (
        max(0, int(left - pad_x)),
        max(0, int(top - pad_y)),
        min(image.width, int(right + pad_x)),
        min(image.height, int(bottom + pad_y)),
    )
    if box[2] <= box[0] or box[3] <= box[1]:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    image.crop(box).resize((CROP_SIZE, CROP_SIZE), Image.Resampling.LANCZOS).save(
        dest, format="JPEG", quality=85
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Detect and embed the faces of one video.")
    parser.add_argument("--claim", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    claim = json.loads(Path(args.claim).read_text(encoding="utf-8"))
    count, sample_ms = plan_sampling(int(claim["durationMs"]), int(claim["sampleMs"]))
    if count == 0:
        raise SystemExit("the asset has no duration, so it has no frames to sample")

    from insightface.app import FaceAnalysis
    from PIL import Image

    app = FaceAnalysis(
        name=claim["modelId"],
        root=claim["modelDir"],
        providers=[claim["providers"]],
        allowed_modules=["detection", "recognition"],
    )
    app.prepare(ctx_id=-1, det_size=(DETECT_SIZE, DETECT_SIZE))
    log.info("detector ready, %d frames every %dms", count, sample_ms)

    workdir = Path(tempfile.mkdtemp(prefix="face-stage-"))
    frames_dir = workdir / "frames"
    faces: list[dict[str, Any]] = []
    expected = int(claim["dimensions"])
    try:
        extract_frames(claim["mediaPath"], frames_dir, sample_ms, count)
        paths = sorted(frames_dir.glob("*.jpg"))
        if not paths:
            raise SystemExit("ffmpeg produced no frames")

        for index, path in enumerate(paths):
            image = Image.open(path).convert("RGB")
            detections = app.get(__import__("numpy").array(image)[:, :, ::-1])
            frame_ms = int((index + 0.5) * sample_ms)
            for order, face in enumerate(detections):
                score = float(getattr(face, "det_score", 0.0))
                if score < float(claim["minScore"]):
                    continue
                vector = getattr(face, "normed_embedding", None)
                if vector is None:
                    vector = getattr(face, "embedding", None)
                if vector is None:
                    continue
                if len(vector) != expected:
                    raise RuntimeError(
                        f"the model returned {len(vector)} dimensions, expected {expected}"
                    )
                bbox = face.bbox
                thumb_rel = f"faces/{claim['assetId']}/{frame_ms:09d}-{order}.jpg"
                crop_face(image, bbox, Path(claim["cacheDir"]) / thumb_rel)
                faces.append(
                    {
                        "frameMs": frame_ms,
                        "x": float(bbox[0]),
                        "y": float(bbox[1]),
                        "width": float(bbox[2] - bbox[0]),
                        "height": float(bbox[3] - bbox[1]),
                        "score": score,
                        "thumbnailPath": thumb_rel,
                        "vector": encode_vector(vector),
                    }
                )
            print(f"PROGRESS {(index + 1) / len(paths):.4f}", flush=True)

        Path(args.out).write_text(json.dumps({"faces": faces}), encoding="utf-8")
        log.info("%d faces in %d frames", len(faces), len(paths))
    finally:
        import shutil

        shutil.rmtree(workdir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
