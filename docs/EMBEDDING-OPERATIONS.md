# 임베딩 운영

영상의 파일명과 전사 텍스트를 Qwen3-Embedding-4B로 벡터로 바꿔 저장한다. `/api/assets/:id/related`는 이 벡터가 있으면 같은 폴더가 아니라 의미가 가까운 영상을 먼저 보여준다. 벡터가 아직 없는 영상은 예전처럼 폴더 기준으로 나온다.

ASR과 번역, 임베딩, NVENC 인코딩은 같은 GPU를 나눠 쓴다. 임베딩 worker는 작업을 시작하기 전에 GPU lease를 잡고, 끝나면 llama-server를 종료한 뒤 lease를 놓는다. 다른 소비자가 카드를 잡고 있으면 최대 `GPU_WAIT_SECONDS`만큼 기다리고, 그 안에 얻지 못하면 작업을 실패로 기록한다. playback은 카드를 기다리지 않으므로 미디어 worker만 lease를 못 잡으면 CPU로 인코딩한다.

## 1. 준비

- 모델 파일 2.5GB와 교체용 여유 공간을 합쳐 SSD에 12GB 이상이 필요하다. 모델은 `./models`에 두고 미디어 드라이브에는 두지 않는다.
- CUDA 경로는 NVIDIA 드라이버와 Docker GPU 런타임이 필요하다. macOS 경로는 호스트에 llama.cpp가 필요하다.
- `.env.embedding.example`을 `.env.embedding`으로 복사하고 값을 채운다.

`EMBEDDING_MODEL_REVISION`에는 `main` 대신 확인한 40자리 커밋 SHA를 넣는다. `EMBEDDING_MODEL_SHA256`은 비워 두지 않는다. 다운로드 서비스가 이 값과 다른 파일을 거부한다.

`EMBEDDING_WORKER_TOKEN`은 API와 worker가 같은 값을 써야 한다. 16자 미만이면 API가 기동을 거부한다.

## 2. 모델 내려받기

CUDA 호스트에서 다음을 실행한다.

```bash
docker compose -f compose.yaml -f compose.embedding.models.yaml run --rm embedding-model-init
```

서비스는 `Qwen3-Embedding-4B-Q4_K_M.gguf` 한 파일만 내려받는다. `.staging`에서 SHA256과 `GGUF` 헤더를 확인한 뒤 최종 경로로 원자적 이름 변경을 하고, 이전 파일은 `.archive`에 남긴다. 결과는 `models/embedding/model-manifest.json`에 기록된다.

같은 커밋과 같은 SHA의 파일이 이미 있으면 아무것도 내려받지 않고 종료한다. 중간에 끊겨도 `.staging`만 지우고 다시 실행하면 된다.

번역과 같은 `packages/model-init/download_model.py`를 쓴다. 두 이미지의 차이는 `MODEL_ENV_PREFIX` 하나이고, 디렉터리 이름과 로그 라벨은 그 값에서 파생된다.

## 3. WSL2와 CUDA에서 실행

```bash
docker compose -f compose.yaml -f compose.embedding.models.yaml -f compose.embedding.cuda.yaml up -d --build
```

`embedding-worker`는 `embedding-model-init`이 성공한 뒤에 시작한다. worker는 llama-server를 직접 띄우고 작업이 끝나면 종료한다. 상시 실행되는 llama-server 컨테이너는 두지 않는다. 8GB 카드에서 ASR과 번역, 임베딩이 동시에 VRAM을 잡지 않게 하려는 선택이다.

로그에서 다음 두 줄을 확인한다.

```bash
docker compose -f compose.yaml -f compose.embedding.cuda.yaml logs -f embedding-worker
```

```
worker ... ready: model=/models/embedding/Qwen3-Embedding-4B-Q4_K_M.gguf
job ... finished in ...s
```

`LLAMA_CTX=8192`는 제목 한 줄과 1200자 구절 8개를 한 번에 처리하기 위한 값이다. OOM이 나면 `EMBEDDING_BATCH_SIZE`를 4로 낮추고 `LLAMA_GPU_LAYERS`를 조정한다.

## 4. macOS에서 실행

Docker Desktop의 Linux 컨테이너는 Apple Metal을 쓰지 못한다. 모델과 API만 Compose로 띄우고 worker는 호스트에서 실행한다.

```bash
docker compose -f compose.yaml -f compose.embedding.models.yaml up -d --build
docker compose -f compose.yaml run --rm embedding-model-init
```

호스트에서 llama.cpp를 설치한 뒤 worker를 실행한다.

```bash
brew install llama.cpp

cd apps/embedding-worker
uv sync --python 3.12 --extra dev

API_BASE_URL=http://127.0.0.1:8788 \
EMBEDDING_WORKER_TOKEN=<.env.embedding과 같은 값> \
EMBEDDING_MODEL_PATH=../../models/embedding/Qwen3-Embedding-4B-Q4_K_M.gguf \
LLAMA_SERVER="$(command -v llama-server)" \
.venv/bin/python -m embedding_worker.main
```

worker는 `127.0.0.1`에만 바인딩한다. llama-server를 LAN에 열지 않는다. 메모리 압박을 피하려고 동시 임베딩은 1개로 둔다.

## 5. 기존 라이브러리 채우기

ASR이 끝난 영상은 자동으로 임베딩 작업이 큐에 들어간다. 그 전에 이미 들어와 있던 영상은 한 번 돌려야 한다.

```bash
bun run scripts/backfill-embeddings.ts --dry-run
MV_USERNAME=<계정> MV_PASSWORD=<비밀번호> bun run scripts/backfill-embeddings.ts
```

스크립트는 `data/mediavault.db`를 읽기 전용으로 열어 영상 목록을 만들고, 각 영상에 `POST /api/assets/<assetId>/embedding`을 호출한다. DB를 직접 고치지 않는다. 세션이 이미 있으면 `MV_SESSION`에 `mv_session` 쿠키 값을 넣어 로그인을 건너뛴다.

전사가 없는 영상도 함께 넣는다. worker가 파일명만 임베딩하므로 그 영상도 의미 검색에 등장한다. 빼면 그 영상은 `/related`에 영원히 나오지 않는다.

같은 영상에 두 번 실행해도 작업 행은 하나로 유지된다. 모델 지문이나 원문 전사가 바뀐 경우에만 그 행이 `queued`로 돌아간다.

## 6. 동작 확인

```bash
curl -X POST http://127.0.0.1:8787/api/assets/<assetId>/embedding \
  -H 'content-type: application/json' -b 'mv_session=<token>' -d '{}'

curl -s 'http://127.0.0.1:8787/api/assets/<assetId>/related?limit=8' -b 'mv_session=<token>'
```

`/related`의 응답은 저장된 벡터로 정렬된다. 벡터가 아직 없는 영상만 폴더 기준으로 답한다.

작업 상태는 큐 화면의 `embedding` 레인에서 본다. 저장된 벡터 수는 다음으로 확인한다.

```bash
sqlite3 data/mediavault.db "SELECT kind, count(*) FROM video_embeddings GROUP BY kind;"
```

## 7. 실측값

`Qwen3-Embedding-4B-Q4_K_M.gguf`를 8GB 카드에서 `-c 8192`로 한 번 측정한 값이다. 이 저장소의 테스트가 다시 재는 값이 아니다.

| 항목 | 값 |
| --- | --- |
| 파일 크기 | 2,496,703,776 바이트 |
| 벡터 차원 | 2560 |
| 모델 로드 | 4초 |
| VRAM | 4997 MiB |
| 8개 텍스트 처리 | 1.02초 |
| 같은 주제 한국어 cosine | 0.84 |
| 무관한 영상 cosine | 0.16 ~ 0.28 |
| 같은 주제 영어 cosine | 0.44 |

한국어 영상끼리는 0.84로 확실히 갈리고, 한국어와 영어가 같은 주제인 경우는 0.44로 중간에 놓인다. 언어가 섞인 라이브러리에서 컷을 0.5 근처로 잡으면 영어 영상이 일부 빠진다.

## 8. 장애 대응

| 증상 | 원인 | 조치 |
| --- | --- | --- |
| `422 invalid_vector` | 벡터 길이가 `dimensions * 4`가 아니거나 NaN/Inf 포함 | worker 로그에서 차원을 확인하고 `EMBEDDING_DIMENSIONS`가 2560인지 맞춘다. API는 이 응답을 준 뒤 저장하지 않는다. |
| `409 lease_lost` | heartbeat가 끊겨 다른 worker가 작업을 가져감 | worker가 llama-server를 종료했는지 확인한다. 남아 있으면 직접 종료한 뒤 재시작한다. |
| `GPU is busy with another job.` | ASR이나 번역이 GPU lease를 잡고 있음 | 그 작업이 끝날 때까지 기다린다. 10분을 넘기면 worker가 작업을 실패로 기록한다. |
| `embedding model ... is missing` | 모델 init을 건너뜀 | 2절의 모델 다운로드를 먼저 실행한다. |
| `/related`가 계속 폴더 기준으로 나옴 | 저장된 벡터가 없음 | 5절의 backfill을 돌리고 worker가 도는지 확인한다. |
| 임베딩이 계속 `queued` | worker가 실행 중이 아님, 토큰 불일치 | `EMBEDDING_WORKER_TOKEN`이 API와 worker에서 같은지 확인한다. |
| llama-server가 곧바로 종료됨 | VRAM 부족, 잘못된 모델 경로, CUDA 라이브러리 불일치 | worker 로그의 마지막 stderr를 읽고 `LLAMA_CTX`와 `LLAMA_GPU_LAYERS`를 낮춘다. |
| 모델을 바꿨는데 순위가 그대로 | 지문이 바뀌어 작업은 다시 돌지만 예전 벡터가 남아 있음 | `video_embeddings`의 `model_sha256`이 새 값인지 확인한다. 새 작업이 완료되면 그 영상의 예전 벡터는 지워진다. |

## 9. 되돌리기

`EMBEDDING_ENABLED=0`으로 두고 API를 재시작하면 worker 라우트가 503을 반환하고 `/related`는 폴더 기준으로 돌아간다. 저장된 벡터는 남지만 읽히지 않는다.

벡터를 지우려면 해당 행을 삭제한다. 원본 영상과 전사는 영향을 받지 않는다.

```bash
sqlite3 data/mediavault.db "DELETE FROM video_embeddings WHERE asset_id = '<assetId>';"
sqlite3 data/mediavault.db "DELETE FROM embedding_jobs WHERE asset_id = '<assetId>';"
```

`embedding_jobs`를 지우면 그 영상의 벡터도 cascade로 함께 지워진다. 모델 파일은 `models/embedding/`에 남으므로 필요하면 같이 지운다.

## 10. 검증 범위

이 저장소에서 확인한 것과 확인하지 못한 것을 구분한다.

확인함:

- DB v7 마이그레이션과 임베딩 job, 벡터 저장, GPU lease 동작. 만료된 lease 회수와 소유자 확인을 테스트로 고정했다.
- 청킹: 문자 예산, cue를 쪼개지 않는 규칙, 첫·마지막 시각 유지, 빈 입력
- worker가 파일명을 첫 문서로 보내고, 전사가 없는 영상도 벡터 하나를 보내는지 (fake llama-server)
- 벡터를 base64 float32로 주고받고, 차원이 틀리거나 NaN이면 API가 422로 거부하는지
- backfill 스크립트가 전사가 없는 영상까지 전부 큐에 넣는지. 실제 DB 사본에 API를 띄워 7개 영상 중 6개가 전사 없이 `queued`가 되는 것과, 두 번 실행해도 작업 행이 7개로 유지되는 것을 확인했다.
- 순위: 벡터 3개를 심어 두고 정렬, 자기 자신 제외, 같은 파일 제외가 맞는지

확인하지 못함:

- 실제 Qwen3-Embedding-4B의 순위 품질과 7절의 값 재현. 7절은 한 번의 probe 결과이고 테스트가 다시 재지 않는다.
- CUDA 이미지 빌드와 실제 컨테이너 기동
- 실제 GPU에서 ASR, 번역, 임베딩이 lease로 직렬화되는지 (테스트는 가짜 HTTP 서버까지다)
- macOS M5 Metal에서의 처리 속도

이 항목은 실기기에서 6절의 검증 명령과 8절의 로그를 남긴 뒤 판단한다.
