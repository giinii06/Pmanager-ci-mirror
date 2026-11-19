from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from .model import encode_clip, encode_vector, load_model
from .processes import ProcessTimeout, run_checked

log = logging.getLogger("scene_worker.stage")

CLIP_SIZE = 336
CLIP_FPS = 16
THUMB_WIDTH = 320

FFPROBE_TIMEOUT_SECONDS = 30.0
FFMPEG_TIMEOUT_SECONDS = float(os.environ.get("SCENE_FFMPEG_TIMEOUT_SECONDS", "300"))


def plan_windows(
    duration_ms: int, window_ms: int, overlap_ms: int, max_windows: int = 0
) -> list[tuple[int, int]]:
    """Even windows over the whole file. A file shorter than one window is one window.

    A positive max_windows widens the step so one job never plans more than that
    many windows, sampling the file instead of covering it. The window itself
    stays at the configured length, because the model's memory grows with it.
    """
    if duration_ms <= 0 or window_ms <= 0:
        return []
    step = max(1, window_ms - overlap_ms)
    if max_windows > 0 and duration_ms > step * max_windows:
        step = max(1, -(-duration_ms // max_windows))
    windows: list[tuple[int, int]] = []
    start = 0
    while start < duration_ms:
        end = min(start + window_ms, duration_ms)
        windows.append((start, end))
        if end >= duration_ms:
            break
        start += step
    return windows


def has_audio(path: str) -> bool:
    try:
        result = run_checked(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a",
                "-show_entries",
                "stream=index",
                "-of",
                "csv=p=0",
                path,
            ],
            timeout_seconds=FFPROBE_TIMEOUT_SECONDS,
            capture_stdout=True,
        )
    except ProcessTimeout:
        # A probe that never returns is a broken file or a stuck mount, not
        # "no audio": fail the job instead of silently dropping the audio vectors.
        raise
    except RuntimeError:
        return False
    return (result.stdout or b"").strip() != b""


def cut_clip(source: str, start_ms: int, end_ms: int, dest: Path, *, with_audio: bool) -> None:
    """Cuts one window to a small mp4 the processor can sample 16 frames from."""
    duration = max(0.1, (end_ms - start_ms) / 1000.0)
    common = [
        "-y",
        "-v",
        "error",
        "-ss",
        f"{start_ms / 1000.0:.3f}",
        "-t",
        f"{duration:.3f}",
        "-i",
        source,
    ]
    video_filter = (
        f"scale={CLIP_SIZE}:{CLIP_SIZE}:force_original_aspect_ratio=decrease,"
        f"pad={CLIP_SIZE}:{CLIP_SIZE}:(ow-iw)/2:(oh-ih)/2,setsar=1"
    )
    if with_audio:
        args = common + [
            "-vf",
            video_filter,
            "-r",
            str(CLIP_FPS),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-ar",
            "48000",
            "-ac",
            "1",
            str(dest),
        ]
    else:
        args = common + [
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=48000:cl=mono",
            "-vf",
            video_filter,
            "-r",
            str(CLIP_FPS),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-shortest",
            "-c:a",
            "aac",
            "-ar",
            "48000",
            "-ac",
            "1",
            str(dest),
        ]
    run_checked(["ffmpeg", *args], timeout_seconds=FFMPEG_TIMEOUT_SECONDS)


def write_thumbnail(source: str, at_ms: int, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    run_checked(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-ss",
            f"{at_ms / 1000.0:.3f}",
            "-i",
            source,
            "-frames:v",
            "1",
            "-vf",
            f"scale={THUMB_WIDTH}:-2",
            "-q:v",
            "4",
            str(dest),
        ],
        timeout_seconds=FFMPEG_TIMEOUT_SECONDS,
    )


def write_window_thumbnail(
    media_path: str,
    clip: Path,
    start_ms: int,
    end_ms: int,
    dest: Path,
    *,
    from_clip: bool,
) -> None:
    """Writes the window thumbnail before the caller deletes the clip.

    The clip starts at `start_ms`, so its own timestamp for the midpoint is the
    midpoint minus the window start.
    """
    if from_clip:
        write_thumbnail(str(clip), (start_ms + end_ms) // 2 - start_ms, dest)
    else:
        write_thumbnail(media_path, (start_ms + end_ms) // 2, dest)


def main() -> int:
    parser = argparse.ArgumentParser(description="Embed the windows of one video with PE-AV.")
    parser.add_argument("--claim", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    claim = json.loads(Path(args.claim).read_text(encoding="utf-8"))
    duration_ms = int(claim["durationMs"])
    windows = plan_windows(
        duration_ms,
        int(claim["windowMs"]),
        int(claim["overlapMs"]),
        int(claim.get("maxWindows", 0)),
    )
    if not windows:
        raise SystemExit("the asset has no duration, so it has no windows")
    log.info("%d windows over %d ms", len(windows), duration_ms)

    import torch
    from transformers import PeAudioVideoProcessor

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device == "cuda" else None
    cache = claim["modelDir"]
    processor = PeAudioVideoProcessor.from_pretrained(claim["modelId"], cache_dir=cache)
    model = load_model(claim["modelId"], cache, device=device, dtype=dtype)
    log.info("model ready on %s", device)

    audio_present = has_audio(claim["mediaPath"])
    if not audio_present:
        log.info("the asset has no audio track, so every window gets silence")

    expected = int(claim["dimensions"])
    thumbnail_from_clip = os.environ.get("SCENE_THUMBNAIL_FROM_CLIP", "0") == "1"
    scenes: list[dict[str, Any]] = []
    cut_ms = 0.0
    thumbnail_ms = 0.0
    workdir = Path(tempfile.mkdtemp(prefix="scene-stage-"))
    try:
        for index, (start_ms, end_ms) in enumerate(windows):
            clip = workdir / f"clip-{index:04d}.mp4"
            cut_started = time.perf_counter()
            cut_clip(claim["mediaPath"], start_ms, end_ms, clip, with_audio=audio_present)
            cut_ms += (time.perf_counter() - cut_started) * 1000
            try:
                visual, audio, joint = encode_clip(
                    model, processor, str(clip), device=device, dtype=dtype
                )
                visual_vector = visual[0].float().cpu().tolist()
                audio_vector = audio[0].float().cpu().tolist()
                joint_vector = joint[0].float().cpu().tolist()
                if len(visual_vector) != expected:
                    raise RuntimeError(
                        f"the model returned {len(visual_vector)} dimensions, expected {expected}"
                    )

                thumb_rel = f"scenes/{claim['assetId']}/{index:04d}.jpg"
                thumb_started = time.perf_counter()
                write_window_thumbnail(
                    claim["mediaPath"],
                    clip,
                    start_ms,
                    end_ms,
                    Path(claim["cacheDir"]) / thumb_rel,
                    from_clip=thumbnail_from_clip,
                )
                thumbnail_ms += (time.perf_counter() - thumb_started) * 1000
            finally:
                clip.unlink(missing_ok=True)

            scenes.append(
                {
                    "seq": index,
                    "startMs": start_ms,
                    "endMs": end_ms,
                    "thumbnailPath": thumb_rel,
                    "visual": encode_vector(visual_vector),
                    "audio": encode_vector(audio_vector),
                    "av": encode_vector(joint_vector),
                }
            )
            print(f"PROGRESS {(index + 1) / len(windows):.4f}", flush=True)

        log.info(
            json.dumps(
                {
                    "event": "scene.window_prepare",
                    "windows": len(windows),
                    "cutMs": round(cut_ms, 1),
                    "thumbnailMs": round(thumbnail_ms, 1),
                }
            )
        )
        Path(args.out).write_text(json.dumps({"scenes": scenes}), encoding="utf-8")
    finally:
        import shutil

        shutil.rmtree(workdir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
