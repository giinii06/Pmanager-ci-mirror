# Downloads the PE-AV checkpoint into ./models/scene in the Hugging Face cache
# layout the worker reads offline. Weights never enter the image.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    HF_XET_HIGH_PERFORMANCE=1

RUN pip install --no-cache-dir "huggingface_hub==2.4.0" "hf_xet==1.8.0"

WORKDIR /app
COPY apps/scene-model-init/download_models.py /app/download_models.py

ENTRYPOINT ["python", "/app/download_models.py"]
