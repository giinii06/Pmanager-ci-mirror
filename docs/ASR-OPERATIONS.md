# ASR 운영 문서

MediaVault의 AI 자막 파이프라인을 설치하고 운영하는 방법입니다. 대상 독자는 이 저장소를 직접 배포하는 사람입니다.

## 무엇이 추가되었나

자막은 기존 스택과 분리된 큐에서 처리됩니다.

- 한국어 음성 인식은 `TeamUNIVA/qwen3_asr_1.7b_ko`, 단어 단위 시간 정렬은 `Qwen/Qwen3-ForcedAligner-0.6B`를 사용합니다.
- 모델 가중치는 이미지에 들어가지 않습니다. `asr-model-init` 컨테이너가 시작할 때 `./models`로 내려받고, 이후 재빌드해도 다시 받지 않습니다.
- 작업 큐는 기존 `jobs` 테이블이 아니라 `asr_jobs` 테이블에 있습니다. 사진·동영상 갤러리의 썸네일/HLS 작업과 서로 밀어내지 않습니다.
- Python 워커는 SQLite를 직접 쓰지 않습니다. 모든 상태 변경은 Fastify API의 `/worker/asr/*` 엔드포인트를 통합니다.
- 결과 파일은 `./asr-results`에, 원본 영상은 읽기 전용으로만 접근합니다.

## 준비물

| 항목 | WSL2 / Linux | macOS (Apple Silicon) |
|---|---|---|
| 실행 위치 | Docker 컨테이너 (CUDA) | 호스트 네이티브 (PyTorch MPS) |
| GPU | NVIDIA, CUDA 12.8 이상 드라이버 | Metal을 쓰는 M 계열 |
| 모델 다운로드 | `asr-model-init` 컨테이너 | 같은 컨테이너 |
| Python | 이미지 내부 3.12 | 3.12 (`uv` 권장) |
| 디스크 | 모델 8GB 이상 + 결과용 SSD | 동일 |

원본 미디어는 절대 결과 저장소로 쓰지 않습니다. `/mnt/d/Media` 같은 HDD는 `/media:ro`로만 마운트하고, `./models`, `./asr-results`, SQLite는 SSD에 둡니다.

## 1. 모델 내려받기

`.env.asr.example`을 `.env.asr`로 복사하고 값을 채웁니다. 최소한 아래 세 개가 필요합니다.

```bash
ASR_WORKER_TOKEN=$(openssl rand -hex 32)
ASR_MODEL_REVISION=a8b7485274ac50e80a685f3813489fed475adc5f
ALIGN_MODEL_REVISION=c7cbfc2048c462b0d63a45797104fc9db3ad62b7
```

Compose는 `.env`만 기본으로 읽고 `.env.asr`은 스스로 읽지 않습니다. 이 문서의 ASR 명령에는 `--env-file .env --env-file .env.asr`을 붙입니다.

그다음 한 번만 실행합니다.

```bash
mkdir -p models asr-results
docker compose --env-file .env --env-file .env.asr \
  -f compose.yaml -f compose.asr.models.yaml run --rm asr-model-init
ls -lah models/asr models/aligner
```

`models/asr/model-manifest.json`과 `models/aligner/model-manifest.json`에 실제 커밋 SHA, 파일 목록, 다운로드 시각이 기록됩니다.

동작 방식:

- 요청한 리비전과 매니페스트가 같고 필수 파일 검사(가중치 헤더 파싱 포함)가 통과하면 즉시 종료합니다.
- 새 리비전이면 `.staging/`에 받아 검증한 뒤에만 `models/asr`로 교체합니다. 기존 모델은 `.archive/asr-<시각>`으로 이동하므로 롤백은 디렉터리를 되돌리는 것으로 끝납니다.
- 실패하면 기존 모델은 그대로 남습니다.

## 2-A. WSL2 / Linux에서 GPU 워커 실행

```bash
nvidia-smi
docker run --rm --gpus all nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04 nvidia-smi

docker compose --env-file .env --env-file .env.asr \
  -f compose.yaml -f compose.asr.models.yaml \
  -f compose.asr.cuda.yaml config -q

docker compose --env-file .env --env-file .env.asr \
  -f compose.yaml -f compose.asr.models.yaml \
  -f compose.asr.cuda.yaml up -d --build
```

`asr-worker`는 `api`가 healthy이고 `asr-model-init`이 성공한 뒤에 시작합니다. 작업은 한 번에 하나만 처리합니다.

RTX 50 계열은 CUDA 12.8 이상이 필요합니다. 이미지 빌드 중 `torch.version.cuda`를 확인하지만, 실제 연산 가능 여부는 아래 스모크 테스트로 확인합니다.

## 2-B. macOS에서 네이티브 워커 실행

Docker for Mac의 Linux 컨테이너는 Metal을 쓰지 못합니다. 모델 다운로드와 나머지 서비스만 Compose로 띄우고, 워커는 호스트에서 실행합니다.

```bash
docker compose --env-file .env --env-file .env.asr \
  -f compose.yaml -f compose.asr.mac-api.yaml up -d --build
```

API는 `127.0.0.1:8788`에만 열립니다. LAN에 노출하지 마세요.

```bash
cd apps/asr-worker
uv sync --python 3.12 --extra dev

ASR_WORKER_TOKEN=<.env.asr과 같은 값> \
ASR_MODEL_REVISION=a8b7485274ac50e80a685f3813489fed475adc5f \
ALIGN_MODEL_REVISION=c7cbfc2048c462b0d63a45797104fc9db3ad62b7 \
ASR_PIPELINE_VERSION=1 \
API_BASE_URL=http://127.0.0.1:8788 \
ASR_DEVICE=mps \
ASR_MODEL_DIR=../../models/asr \
ALIGN_MODEL_DIR=../../models/aligner \
MEDIA_ROOT=../../sample-media \
RESULT_DIR=../../asr-results \
HF_HUB_OFFLINE=1 \
.venv/bin/python -m asr_worker.main
```

워커의 `ASR_MODEL_REVISION`, `ALIGN_MODEL_REVISION`, `ASR_PIPELINE_VERSION`은
API와 같아야 합니다. 다르면 첫 작업이 revision 불일치로 실패합니다.

MPS 지원은 실기기에서 확인해야 합니다. 특정 연산이 실패하면 `ASR_DEVICE=cpu`로 같은 작업을 다시 돌려 결과를 비교하고, 속도가 기준에 못 미치면 그 사실을 사용자에게 알립니다.

## 환경 변수

| 이름 | 기본값 | 의미 |
|---|---|---|
| `ASR_WORKER_TOKEN` | 없음(필수) | API와 워커가 공유하는 비밀키. 16자 이상 |
| `ASR_ENABLED` | 토큰이 있으면 1 | 0이면 자막 API가 503을 반환 |
| `ASR_RESULT_DIR` | `./asr-results` | 결과 파일 루트 |
| `ASR_MODEL_REVISION` | `main` | 결과 캐시 키에 포함 |
| `ALIGN_MODEL_REVISION` | `main` | 결과 캐시 키에 포함 |
| `ASR_PIPELINE_VERSION` | `1` | 청킹/자막 로직 변경 시 올림 |
| `ASR_DEVICE` | `auto` | `cuda` / `mps` / `cpu` / `auto` |
| `ASR_MODEL_DIR` | `/models/asr` | 워커가 읽는 ASR 경로 |
| `ALIGN_MODEL_DIR` | `/models/aligner` | 워커가 읽는 정렬기 경로 |
| `MEDIA_ROOT` | `/media` | 읽기 전용 원본 루트 |
| `RESULT_DIR` | `/asr-results` | 워커의 결과 루트 |
| `ASR_MIN_CHUNK_MS` / `ASR_MAX_CHUNK_MS` | 15000 / 30000 | 음성 청크 길이 |
| `ASR_LEASE_MS` | 120000 | 작업 임대 시간. 하트비트가 갱신 |
| `GPU_WAIT_SECONDS` | 600 | GPU lease가 잡혀 있을 때 모델 단계가 기다리는 시간. 넘기면 작업을 실패로 기록 |
| `ASR_KEEP_WORKDIR` | 0 | 1이면 임시 오디오를 남겨 디버깅 |

## 파이프라인

1. 원본 경로를 `realpath`로 검증한 뒤 `ffmpeg`로 16kHz 모노 PCM을 뽑습니다.
2. `silencedetect`로 무음 구간을 찾아 청크를 만듭니다. 무음 중간점에서 자르므로 어절이 잘리지 않고, 무음이 없으면 `ASR_MAX_CHUNK_MS`(기본 30초)에서 자릅니다. 마지막 청크는 3초까지 짧아질 수 있고, 3초 미만이면 앞 청크에 합쳐져 그 청크가 최대 길이를 조금 넘습니다. 입력이 30초 이하면 나누지 않습니다.
3. 별도 프로세스에서 ASR을 실행하고 청크마다 체크포인트를 남깁니다.
4. ASR 프로세스가 끝나면 모델을 내리고, 별도 프로세스에서 정렬기를 실행합니다. 8GB 카드에서 두 모델이 동시에 상주하지 않습니다. 각 프로세스는 시작 전에 GPU lease를 잡고 끝난 뒤에 놓으므로, 같은 카드에서 번역 worker가 동시에 돌지 않습니다.
5. 청크 오프셋을 더해 전역 타임라인을 만듭니다. `start <= end`, 청크 범위, 비감소 순서를 검사하고 300ms를 넘는 역전은 그 청크를 버립니다.
6. 문장 단위로 묶어 VTT/SRT/JSON/TXT를 원자적으로 씁니다.

정렬에 실패한 구간은 자막에 넣지 않습니다. 임의 타임스탬프를 만들지 않습니다.

## 결과 저장 구조와 캐시

```text
asr-results/{asset_id}/{file_version}/{asr_rev}_{aligner_rev}_{pipeline}/
    transcript.json   # 단어·문장 타임스탬프, 청크 상태
    transcript.txt
    subtitles.srt
    subtitles.vtt
```

`asset_id + file_version + model_revision + aligner_revision + pipeline_version`이 결과의 정체성입니다. 영상 파일이 바뀌면 `file_version`이 올라가므로 이전 자막을 재생하지 않습니다. 모델이나 파이프라인 버전이 바뀌면 새 작업이 만들어집니다.

## API 계약

사용자 경로(세션 쿠키 필요):

```http
POST /api/assets/:id/transcribe            # {"force": false}
GET  /api/assets/:id/transcription/status
GET  /api/assets/:id/transcription
GET  /api/assets/:id/subtitles.vtt
GET  /api/assets/:id/subtitles.srt
GET  /api/assets/:id/transcript/search?q=
```

워커 전용 경로(`X-Worker-Token` 헤더, Nginx에 노출되지 않음):

```http
POST /worker/asr/claim
POST /worker/asr/jobs/:id/heartbeat
POST /worker/asr/jobs/:id/progress
POST /worker/asr/jobs/:id/complete
POST /worker/asr/jobs/:id/fail
```

브라우저에는 워커 토큰을 절대 내려보내지 않습니다.

## 검증

모델과 장치를 먼저 확인할 때는 API 없이 한 파일만 돌리는 스모크 스크립트를 쓴다.

```bash
cd apps/asr-worker
.venv/bin/python scripts/smoke.py /path/to/clip.mp4 --device mps
```

출력에는 청크 수, 단계별 소요 시간, 실시간 계수(RTF), 앞부분 자막이 나온다. RTF가 1보다 작으면 실시간보다 빠르다는 뜻이다.

이 저장소에서 Apple M5 24GB, MPS로 측정한 값(참고용, 보장 아님):

| 항목 | 값 |
|---|---|
| 입력 | 97.6초 한국어 영상, 1080×1920 |
| 청크 | 4개 (30초 × 3 + 7.64초) |
| 음성 인식 | 34.1초 |
| 시간 정렬 | 3.5초 |
| 전체 | 37.8초, RTF 0.39 |
| 결과 | 자막 43줄, 4개 청크 모두 정렬 성공 |

무음 검출을 고친 뒤 같은 파일로 다시 측정한 값이다. 이 파일은 평균 음량 -11.2dB에 배경 음악이 깔려 있어 -70dB에서도 0.35초 이상 무음이 없고, 그래서 청크는 여전히 30초 하드 컷 세 번과 7.64초 꼬리로 나뉜다. 즉 이 행은 무음이 없을 때의 경로를 보여 줄 뿐이고, 무음 중간점 절단 자체는 `tests/test_audio.py`가 합성 오디오로 검증한다.

RTX 5060 Ti에서는 아직 측정하지 않았다. CUDA 컨테이너를 처음 띄운 뒤 같은 스크립트로 `--device cuda`를 돌려 VRAM 피크와 RTF를 기록해야 한다.

## 운영 점검

- [ ] `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8787/worker/asr/claim`가 401인지
- [ ] Nginx가 `/worker/`를 프록시하지 않는지
- [ ] `docker compose logs -f asr-worker`에 작업 진행이 찍히는지
- [ ] 영상 파일을 교체한 뒤 이전 자막이 사라지는지
- [ ] 워커를 강제 종료한 뒤 같은 작업이 중복 없이 다시 도는지
- [ ] 사진 갤러리 첫 화면이 느려지지 않았는지

## 문제 해결

**`ASR_WORKER_TOKEN must be at least 16 characters`** — API가 시작 단계에서 거부합니다. 토큰을 채우세요.

**워커가 `ASR model directory ... is missing`으로 종료** — `asr-model-init`을 먼저 실행하세요.

**`claim`이 401** — API와 워커의 토큰이 다릅니다.

**`lease lost`** — 워커가 오래 멈춰 임대가 만료됐습니다. 다음 claim이 작업을 다시 큐에 넣습니다.

**정렬 단계만 실패** — 해당 청크는 자막에서 빠지고 작업은 실패로 기록됩니다. `asr-results/.../transcript.json`의 `chunks[].align_error`를 확인하세요.

**MPS에서 연산 오류** — `ASR_DEVICE=cpu`로 같은 파일을 처리해 결과를 비교합니다. CPU는 느리지만 정확도 기준을 맞출 수 있습니다.

## 롤백

- 모델: `models/.archive/asr-<시각>`을 `models/asr`로 되돌리고 `asr-model-init`을 다시 실행합니다.
- 스키마: v3는 테이블만 추가합니다. 되돌리려면 백업(`data/mediavault.db.bak-v2`)을 복원합니다.
- 코드: `compose.asr.*.yaml`을 빼고 기존 `compose.yaml`만 띄우면 자막 기능만 사라지고 갤러리는 그대로 동작합니다.
