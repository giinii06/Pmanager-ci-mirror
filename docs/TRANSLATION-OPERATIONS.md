# 번역 자막 운영

영상의 원문 전사가 한국어가 아니면 번역 worker가 Index-Translate-9B로 한국어 자막을 만든다. 원문 전사와 원문 자막은 그대로 남고, 번역은 별도 트랙으로 저장된다. 플레이어는 번역이 준비되면 한국어를 기본으로 열고 원문으로 전환할 수 있다.

ASR과 번역은 같은 GPU를 나눠 쓴다. 번역 worker는 작업을 시작하기 전에 GPU lease를 잡고, 끝나면 llama-server를 종료한 뒤 lease를 놓는다. ASR 작업이 도는 동안에는 번역이 시작되지 않는다.

## 1. 준비

- 모델 파일 5.78GB와 교체용 여유 공간을 합쳐 SSD에 12GB 이상이 필요하다. 모델은 `./models`에 두고 미디어 드라이브에는 두지 않는다.
- CUDA 경로는 NVIDIA 드라이버와 Docker GPU 런타임이 필요하다. macOS 경로는 호스트에 llama.cpp가 필요하다.
- `.env.translation.example`을 `.env.translation`으로 복사하고 값을 채운다.

`TRANSLATION_MODEL_REVISION`에는 `main` 대신 확인한 40자리 커밋 SHA를 넣는다. `TRANSLATION_MODEL_SHA256`은 비워 두지 않는다. 다운로드 서비스가 이 값과 다른 파일을 거부한다.

## 2. 모델 내려받기

CUDA 호스트에서 다음을 실행한다.

```bash
docker compose -f compose.yaml -f compose.translation.models.yaml run --rm translation-model-init
```

서비스는 `Index-Translate-9B.Q4_K_M.gguf` 한 파일만 내려받는다. `.staging`에서 SHA256과 `GGUF` 헤더를 확인한 뒤 최종 경로로 원자적 이름 변경을 하고, 이전 파일은 `.archive`에 남긴다. 결과는 `models/translation/model-manifest.json`에 기록된다.

같은 커밋과 같은 SHA의 파일이 이미 있으면 아무것도 내려받지 않고 종료한다. 중간에 끊겨도 `.staging`만 지우고 다시 실행하면 된다.

## 3. WSL2와 CUDA에서 실행

```bash
docker compose -f compose.yaml -f compose.translation.models.yaml -f compose.translation.cuda.yaml up -d --build
```

`translation-worker`는 `translation-model-init`이 성공한 뒤에 시작한다. worker는 llama-server를 직접 띄우고 작업이 끝나면 종료한다. 상시 실행되는 llama-server 컨테이너는 두지 않는다. 8GB 카드에서 ASR과 번역이 동시에 VRAM을 잡지 않게 하려는 선택이다.

로그에서 다음 두 줄을 확인한다.

```bash
docker compose -f compose.yaml -f compose.translation.cuda.yaml logs -f translation-worker
```

```
worker ... ready: model=/models/translation/Index-Translate-9B.Q4_K_M.gguf
job ... finished in ...
```

`--n-gpu-layers 99`는 목표값이다. OOM이 나면 `LLAMA_GPU_LAYERS`를 낮추고 `LLAMA_CTX`를 2048로 줄인다. 파일이 5.78GB라는 이유만으로 8GB 카드에 항상 들어간다고 가정하지 않는다. 첫 실행 뒤 `nvidia-smi`로 실제 사용량을 기록한다.

## 4. macOS에서 실행

Docker Desktop의 Linux 컨테이너는 Apple Metal을 쓰지 못한다. 모델과 API만 Compose로 띄우고 worker는 호스트에서 실행한다.

```bash
docker compose -f compose.yaml -f compose.translation.models.yaml -f compose.translation.mac-api.yaml up -d --build
```

호스트에서 llama.cpp를 설치한 뒤 worker를 실행한다.

```bash
brew install llama.cpp

cd apps/translation-worker
uv sync --python 3.12 --extra dev

API_BASE_URL=http://127.0.0.1:8788 \
TRANSLATION_WORKER_TOKEN=<.env.translation과 같은 값> \
TRANSLATION_MODEL_PATH=../../models/translation/Index-Translate-9B.Q4_K_M.gguf \
RESULT_DIR=../../asr-results \
LLAMA_SERVER="$(command -v llama-server)" \
.venv/bin/python -m translation_worker.main
```

worker는 `127.0.0.1`에만 바인딩한다. llama-server를 LAN에 열지 않는다. 메모리 압박을 피하려고 동시 번역은 1개로 둔다.

## 5. 동작 확인

원문 전사가 끝난 영상에서 번역을 요청한다.

```bash
curl -X POST http://127.0.0.1:8787/api/assets/<assetId>/translations \
  -H 'content-type: application/json' -b 'mv_session=<token>' -d '{}'
```

상태와 트랙 목록을 확인한다.

```bash
curl -s 'http://127.0.0.1:8787/api/assets/<assetId>/translations/status?lang=ko' -b 'mv_session=<token>'
curl -s 'http://127.0.0.1:8787/api/assets/<assetId>/subtitle-tracks' -b 'mv_session=<token>'
```

번역이 끝나면 `subtitle-tracks`의 `defaultLanguage`가 `ko`가 되고 `subtitles.vtt?lang=ko`가 번역 자막을 반환한다. `lang`을 빼거나 `lang=original`을 주면 원문 자막이 나온다.

원문이 이미 한국어인 영상은 번역 작업을 만들지 않는다. `POST /translations`가 `{ "job": null, "translation": null }`을 반환하는 것이 정상이다.

## 6. 장애 대응

| 증상 | 원인 | 조치 |
| --- | --- | --- |
| `422 segment_mismatch` | 번역 cue 수, 순서, 시작·끝 시각이 원문과 다름 | worker 로그에서 실패한 배치를 찾고 다시 실행한다. API가 이 응답을 준 뒤에는 저장하지 않는다. |
| `409 lease_lost` | heartbeat가 끊겨 다른 worker가 작업을 가져감 | worker가 llama-server를 종료했는지 확인한다. 남아 있으면 직접 종료한 뒤 재시작한다. |
| `GPU is busy with another job.` | ASR이나 다른 번역이 GPU lease를 잡고 있음 | ASR 작업이 끝날 때까지 기다린다. 10분을 넘기면 worker가 작업을 실패로 기록한다. |
| `translation model ... is missing` | 모델 init을 건너뜀 | 2절의 모델 다운로드를 먼저 실행한다. |
| llama-server가 곧바로 종료됨 | VRAM 부족, 잘못된 모델 경로, CUDA 라이브러리 불일치 | worker 로그의 마지막 stderr를 읽고 `LLAMA_GPU_LAYERS`와 `LLAMA_CTX`를 낮춘다. |
| 번역이 계속 `queued` | worker가 실행 중이 아님, 토큰 불일치 | `TRANSLATION_WORKER_TOKEN`이 API와 worker에서 같은지 확인한다. |

## 7. 되돌리기

`TRANSLATION_ENABLED=0`으로 두고 API를 재시작하면 번역 API가 503을 반환하고 플레이어는 원문만 쓴다. 저장된 번역 행은 남지만 읽히지 않는다.

번역 결과를 지우려면 해당 행을 삭제한다. 원문 전사와 원문 자막은 영향을 받지 않는다.

```bash
sqlite3 data/mediavault.db "DELETE FROM translations WHERE asset_id = '<assetId>';"
```

`translation_segments`는 외래 키 cascade로 함께 지워진다. 파일은 `asr-results/<assetId>/<fileVersion>/translations/` 아래에 남으므로 필요하면 같이 지운다.

## 8. 검증 범위

이 저장소에서 확인한 것과 확인하지 못한 것을 구분한다.

확인함:

- DB v4 마이그레이션과 번역 job, 번역 결과, GPU lease 동작
- API의 `lang` 선택, 원문 URL 호환, cue 불일치 거부
- worker가 원문 cue와 같은 수, 같은 시각으로 결과를 쓰는지 (fake llama-server)
- 자막 VTT가 다음 cue 시작까지 이전 줄을 유지하는지

확인하지 못함:

- 실제 Index-Translate-9B의 번역 품질과 일본어 속어 처리
- RTX 5060 Ti 8GB에서의 VRAM 사용량과 처리 속도
- macOS M5 Metal에서의 처리 속도
- CUDA 이미지 빌드와 실제 컨테이너 기동

이 항목은 실기기에서 7절과 8절의 로그를 남긴 뒤 판단한다.
