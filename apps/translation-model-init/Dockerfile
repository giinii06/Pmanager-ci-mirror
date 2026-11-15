# Downloads the GGUF file at container start. Weights are never baked into the
# image, so a rebuild does not re-download 5.78 GB and the host ./models
# directory survives image changes.
#
# The transfer goes through huggingface_hub with the hf_xet backend, which
# fetches a file as concurrent chunks and assembles them. HF_HUB_ENABLE_HF_TRANSFER
# is not used because huggingface_hub 2.4.0 dropped that integration.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    HF_XET_HIGH_PERFORMANCE=1

RUN pip install --no-cache-dir "huggingface_hub==2.4.0" "hf_xet==1.8.0"

WORKDIR /app
COPY apps/translation-model-init/download_model.py /app/download_model.py

ENTRYPOINT ["python", "/app/download_model.py"]
