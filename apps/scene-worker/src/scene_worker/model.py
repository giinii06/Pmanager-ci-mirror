"""The PE-AV checkpoint, loaded the way transformers 5.23 actually needs.

Four defects in the 5.23.0 integration are worked around here. Each one was
measured on the host on 2026-11-15 and is recorded in `.audit/phase3-4.tsv`.

1. The vision tower's head is built from `num_labels`, which the checkpoint
   config leaves at the default of 2 while the weights carry 1024 classes.
2. `tie_word_embeddings` is true in the config but the checkpoint is not tied,
   so loading dies on `bands is not an nn.Parameter`.
3. With tying off, the towers come back independently initialised: the video
   tower, the audio tower and both text towers keep random weights unless the
   matching state dicts are copied across.
4. `get_text_video_embeds` delegates to a method that 5.23.0 defines inside
   `__init__` (so it never exists on the instance), and `get_text_audio_embeds`
   reads `hidden_states` without asking for it. The text vectors are computed
   from the towers directly, exactly as each tower's own `forward` does.

`get_audio_video_embeds` is used for windows instead of `forward()`: the latter
needs two of the three inputs and crashes on the video-only branch.
"""

from __future__ import annotations

import base64
import contextlib
import struct
from typing import Any, Iterator


def load_model(
    model_id: str,
    cache_dir: str,
    *,
    device: str = "cuda",
    dtype: Any = None,
) -> Any:
    """Loads the checkpoint with the config patches and the tower copies applied."""
    import torch
    from transformers import PeAudioVideoConfig, PeAudioVideoModel

    config = PeAudioVideoConfig.from_pretrained(model_id, cache_dir=cache_dir)
    vision = config.audio_video_config.video_config.vision_config
    vision.num_labels = int(getattr(vision, "num_classes", 1024) or 1024)
    config.tie_word_embeddings = False

    model = PeAudioVideoModel.from_pretrained(
        model_id,
        config=config,
        cache_dir=cache_dir,
        dtype=dtype,
        ignore_mismatched_sizes=True,
    )

    _copy_tower("video", model.audio_video_encoder.embedder.video_encoder, model.video_model.video_encoder)
    _copy_tower("audio", model.audio_video_encoder.embedder.audio_encoder, model.audio_model.audio_encoder)
    _copy_tower("text to video", model.video_model.text_model, model.text_model)
    _copy_tower("text to audio", model.audio_model.text_model, model.text_model)

    return model.to(device).eval()


def _copy_tower(label: str, target: Any, source: Any) -> None:
    """Copies one tower and refuses to continue if the shapes do not line up."""
    result = target.load_state_dict(source.state_dict(), strict=False)
    if result.missing_keys or result.unexpected_keys:
        raise RuntimeError(
            f"the {label} tower did not copy cleanly: "
            f"{len(result.missing_keys)} missing, {len(result.unexpected_keys)} unexpected; "
            f"first missing {result.missing_keys[:3]}"
        )


@contextlib.contextmanager
def _autocast(device: str, dtype: Any) -> Iterator[None]:
    import torch

    if device == "cuda" and dtype is not None:
        with torch.autocast("cuda", dtype=dtype):
            yield
        return
    yield


def encode_text(
    model: Any,
    processor: Any,
    text: str,
    *,
    device: str = "cuda",
    dtype: Any = None,
) -> tuple[Any, Any, Any]:
    """Returns the visual, audio and audio-visual query vectors for one phrase."""
    import torch

    inputs = processor(text=[text], return_tensors="pt", padding=True)
    input_ids = inputs["input_ids"].to(device)
    attention = inputs.get("attention_mask")
    if attention is not None:
        attention = attention.to(device)
    with torch.inference_mode(), _autocast(device, dtype):
        hidden = model.text_model(
            input_ids=input_ids,
            attention_mask=attention,
            output_hidden_states=True,
            return_dict=True,
        ).hidden_states[-1][:, 0]
        return (
            model.video_model.text_video_head(hidden),
            model.audio_model.text_audio_head(hidden),
            model.text_audio_video_head(hidden),
        )


def encode_clip(
    model: Any,
    processor: Any,
    clip_path: str,
    *,
    device: str = "cuda",
    dtype: Any = None,
) -> tuple[Any, Any, Any]:
    """Returns the visual, audio and audio-visual vectors for one window clip."""
    import torch

    inputs = processor(videos=[clip_path], audio=[clip_path], return_tensors="pt", padding=True)
    moved = {
        key: (value.to(device) if torch.is_tensor(value) else value)
        for key, value in inputs.items()
    }
    with torch.inference_mode(), _autocast(device, dtype):
        output = model.get_audio_video_embeds(
            input_values=moved["input_values"],
            pixel_values_videos=moved["pixel_values_videos"],
            padding_mask=moved.get("padding_mask"),
            padding_mask_videos=moved.get("padding_mask_videos"),
            return_audio_embeds=True,
            return_video_embeds=True,
        )
    return output.video_embeds, output.audio_embeds, output.audio_video_embeds


def normalise(vector: Any) -> list[float]:
    values = [float(value) for value in vector]
    norm = sum(value * value for value in values) ** 0.5
    if norm == 0:
        raise RuntimeError("the model returned a zero vector")
    return [value / norm for value in values]


def encode_vector(vector: Any) -> str:
    """Base64 of little-endian float32, which is what the API decodes."""
    values = normalise(vector)
    return base64.b64encode(struct.pack(f"<{len(values)}f", *values)).decode("ascii")
