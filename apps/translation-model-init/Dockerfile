# Downloads the GGUF file at container start. Weights are never baked into the
# image, so a rebuild does not re-download 5.78 GB and the host ./models
# directory survives image changes.
#
# The downloader is standard library only, which keeps this image free of a
# package install step and of any Python dependency to audit.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /app
COPY apps/translation-model-init/download_model.py /app/download_model.py

ENTRYPOINT ["python", "/app/download_model.py"]
