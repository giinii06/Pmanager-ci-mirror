# Face indexing runs on the CPU. The GPU lease is the contended resource, and
# SCRFD plus AntelopeV2 are small enough that a face pass never needs the card;
# a CPU worker can index while ASR holds the lease.
#
#   docker compose --env-file .env --env-file .env.face \
#     -f compose.yaml -f compose.face.models.yaml \
#     -f compose.face.yaml up -d --build
#
# opencv-python ships the GUI build, so libGL and libglib are required even
# though nothing opens a window. The ONNX packs arrive through face-model-init.
FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app/src

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        libgl1 \
        libglib2.0-0 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY apps/face-worker/requirements.lock /app/requirements.lock
RUN pip install --upgrade pip \
    && pip install -r /app/requirements.lock \
    && python -c "import onnxruntime, insightface; print('onnxruntime', onnxruntime.__version__, 'insightface', insightface.__version__)"

COPY apps/face-worker/src /app/src

RUN mkdir -p /face-tmp
ENV FACE_TEMP_DIR=/face-tmp

CMD ["python", "-m", "face_worker.main"]
