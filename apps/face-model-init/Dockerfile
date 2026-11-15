# Downloads the AntelopeV2 ONNX pack into ./models/face. No weights in the image.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY apps/face-model-init/download_models.py /app/download_models.py

ENTRYPOINT ["python", "/app/download_models.py"]
