# MediaVault

개인 사진·영상 라이브러리. 원본 폴더는 `api`·`worker`에서 영구 삭제와 `.rar` 추출/변환을 위해 쓰기 가능으로, `nginx`는 읽기 전용으로 마운트하며 SQLite 인덱스와
썸네일 캐시만 따로 만들어 Apple Photos 스타일 갤러리로 보여준다.

- 사진: 320/640 WebP 썸네일 + 1600px 프리뷰를 미리 생성
- 영상: 브라우저가 재생할 수 있으면 Direct Play, 아니면(HEVC/MKV 등) HLS로 변환
- 검색: 파일 이름과 대사는 SQLite FTS5 trigram으로, 장면은 임베딩으로 찾는다. 인덱스가 없거나 깨지면 LIKE 검색으로 응답한다
- 정리: 정확 중복 검토, 영상 북마크, 단일 파일 관리
- 자막(선택): 한국어 음성 인식 + 단어 단위 시간 정렬로 VTT/SRT 생성
- 운영: 설정 하단의 진단 리포트(서버에서 60초 주기로 사전 계산), 요청 id, 캐시 정리, 알림 인박스(선택)
- 웹은 원본 디스크를 직접 훑지 않고 인덱스만 조회. 무거운 작업은 별도 Worker
- 사용자 요청에 의한 영구 삭제와 감지된 `.rar` 아카이브 추출/변환은 `FILE_MUTATION_ENGINE_ENABLED=1`일 때만 원본 폴더를 변경한다. 기본값은 꺼짐이고, 캐시는 지워도 다시 만들어진다

## 구성

```
브라우저
  │  127.0.0.1:8080
  ▼
nginx (edge) ── /            ──▶ web    React SPA (정적)
  │          ── /api/        ──▶ api    Fastify + SQLite + Sharp
  │          ── /internal/*  ──▶ /media, /cache  (X-Accel-Redirect, 외부 차단)
  ▼
worker  스캔 · 썸네일 · 프리뷰 · HLS (ffmpeg)
```

| 컨테이너 | 역할 | 볼륨 |
| --- | --- | --- |
| `nginx` | 유일한 진입점, 인증된 미디어 전송 | `/media:ro`, `/cache:ro` |
| `web` | Vite 빌드 결과를 서빙 | — |
| `api` | REST API, 세션, 썸네일·영구 삭제 | `/media`, `/data`, `/cache` |
| `worker` | 스캔·아카이브 추출·변환 작업 큐 소비 | `/media`, `/data`, `/cache` |
| `asr-worker` 외 (선택) | 음성 인식, 번역, 임베딩, 장면 분석 | `/media:ro`, `/data`, `/cache`, `./models` |

`/data`에는 SQLite DB와 세션 시크릿이, `/cache`에는 썸네일·프리뷰·HLS가 들어간다.
두 디렉터리는 named volume이라 컨테이너를 다시 만들어도 유지된다.

## 빠른 시작 — Docker (WSL2)

전제: WSL2 Ubuntu, Docker Engine + Compose 플러그인. 원본은 Windows 드라이브
`/mnt/d/Media`에 있다고 가정한다.

```bash
git clone <repo> mediavault && cd mediavault
cp .env.example .env
# .env 에서 MEDIA_ROOT=/mnt/d/Media 로 수정
docker compose up -d --build
```

브라우저에서 <http://127.0.0.1:8080> 을 열고 첫 계정을 만든 뒤,
**설정 → 라이브러리 추가**에서 `Photos`, `Videos` 같은 하위 폴더를 등록한다.
등록하면 스캔이 큐에 들어가고, 끝나면 갤러리에 나타난다.

> 포트가 이미 사용 중이면 `.env`의 `MEDIAVAULT_PORT`를 바꾼다. Compose는 항상
> `127.0.0.1`에만 바인딩한다. Windows 호스트에서 LAN으로 접속하려면
> `scripts/windows`의 감독 스크립트가 등록하는 `netsh portproxy`가 필요하고,
> 그때 방화벽 규칙도 함께 만들어진다.

### GPU (선택)

NVIDIA 드라이버, WSL2 GPU 지원, [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)이
준비된 경우:

```bash
docker compose -f compose.yaml -f compose.gpu.yaml up -d --build
```

`HWACCEL=nvenc`로 H.264 인코딩을 시도하고, 실패하면 자동으로 `libx264`로
폴백한다. GPU가 없어도 모든 기능은 동작한다(느릴 뿐). 인코딩 도중에 ASR이나
번역이 카드를 가져가면 그 인코딩은 중단되고 작업이 다시 큐에 들어간다. 그때
카드가 계속 바쁘면 재시도가 `libx264`로 처리한다.

### AI 자막 (선택)

자막은 별도 Python 워커가 처리하며, 기본 스택에는 포함되지 않는다.
모델은 이미지에 넣지 않고 `asr-model-init` 컨테이너가 `./models`로 한 번만
내려받는다. 설치·운영 방법은 [docs/ASR-OPERATIONS.md](docs/ASR-OPERATIONS.md)를
따른다.

```bash
cp .env.asr.example .env.asr   # ASR_WORKER_TOKEN, 모델 커밋 SHA 채우기
docker compose --env-file .env --env-file .env.asr \
  -f compose.yaml -f compose.asr.models.yaml run --rm asr-model-init
```

Compose는 `.env`만 기본으로 읽고 `.env.asr`은 스스로 읽지 않는다. ASR 스택을
띄우는 명령에는 `--env-file .env --env-file .env.asr`을 항상 붙인다.

- WSL2/NVIDIA: `compose.asr.cuda.yaml`을 추가해 GPU 컨테이너로 실행
- macOS: `compose.asr.mac-api.yaml`로 API만 띄우고 워커는 호스트에서 MPS로 실행
- 결과는 `./asr-results`에, 원본은 읽기 전용으로만 접근한다

### 번역 자막 (선택)

원문이 한국어가 아니면 Index-Translate-9B로 한국어 자막을 따로 만든다.
원문 전사와 원문 자막은 그대로 남고, 플레이어에서 원문으로 전환할 수 있다.
모델은 `translation-model-init`이 `./models/translation`으로 내려받는다.
설치·운영 방법은 [docs/TRANSLATION-OPERATIONS.md](docs/TRANSLATION-OPERATIONS.md)를
따른다.

```bash
cp .env.translation.example .env.translation   # 토큰, 모델 커밋 SHA 채우기
docker compose -f compose.yaml -f compose.translation.models.yaml run --rm translation-model-init
```

### 의미 기반 관련 영상 (선택)

`/api/assets/:id/related`가 같은 폴더가 아니라 내용이 비슷한 영상을 먼저 보여주려면
Qwen3-Embedding-4B로 만든 벡터가 필요하다. 파일명과 전사 텍스트를 임베딩하며,
ASR이 끝난 영상은 자동으로 큐에 들어간다. 모델은 `embedding-model-init`이
`./models/embedding`으로 내려받는다. 설치·운영 방법은
[docs/EMBEDDING-OPERATIONS.md](docs/EMBEDDING-OPERATIONS.md)를 따른다.

```bash
cp .env.embedding.example .env.embedding   # 토큰, 모델 커밋 SHA 채우기
docker compose -f compose.yaml -f compose.embedding.models.yaml run --rm embedding-model-init
bun run scripts/backfill-embeddings.ts     # 이미 들어와 있던 영상 채우기
```

벡터가 없는 영상은 예전처럼 폴더 기준으로 관련 영상을 보여준다. 임베딩을 끄면
(`EMBEDDING_ENABLED=0`) 순위는 폴더 기준으로 돌아간다.

## 빠른 시작 — 로컬 개발 (Bun)

Bun 1.4+ 만 있으면 된다. Node, npm, better-sqlite3는 쓰지 않는다.

```bash
bun install
bun run sample     # 샘플 사진 56장 + 영상 5개 생성 (sample-media/)
bun run dev        # API :8787 + Worker + Vite :5173
```

<http://localhost:5173> → 계정 생성 → 설정에서 `Photos`, `Videos` 등록.

| 명령 | 설명 |
| --- | --- |
| `bun run dev` | API·Worker·Vite 동시 실행 |
| `bun test` | 단위·통합 테스트 전체 |
| `bun run release:check` | 릴리스 게이트 전체 (버전 일치, 타입, 테스트, 웹 빌드, 스모크) |
| `bun run smoke` | 실제 API+Worker를 띄우는 end-to-end 스모크 테스트 |
| `bun run typecheck` | 전체 워크스페이스 타입 검사 |
| `bun run preflight` | 미디어 루트 접근성과 여유 공간 확인 |
| `bun run sample` | 샘플 미디어 재생성 |

배포와 릴리스 판정 절차는 [docs/RELEASE.md](docs/RELEASE.md)를 따릅니다.
Windows 무인 부팅 구성은 [docs/WINDOWS-OPERATIONS.md](docs/WINDOWS-OPERATIONS.md)에 있습니다.

## CI 실행과 결과 확인

GitLab `main`에 푸시하면 GitLab이 공개 GitHub 미러를 동기화합니다. GitHub-hosted Runner가 중앙 `ci-hub`의 공통 워크플로에서 Bun 타입 검사와 테스트를 실행합니다.

- [GitHub Actions 실행 로그](https://github.com/giinii06/Pmanager-ci-mirror/actions/workflows/gitlab-bridge.yml)를 확인합니다. 즉시 재실행하려면 해당 실행의 **Re-run jobs**를 선택합니다.
- GitLab 커밋 상세에서 같은 SHA의 `github-actions/ci-hub` 상태를 확인합니다. 상태 보고는 브리지가 실행 중일 때 5분 주기로 반영됩니다.

웹 빌드와 릴리스 검증은 같은 미러의 `ci` 워크플로에서 확인합니다. GitLab 파이프라인에는 Oracle ARM64 러너 점검과 Python 워커 테스트가 별도로 정의되어 있습니다.

## 설정

`.env`(또는 셸 환경변수)로 제어한다.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `MEDIA_ROOT` | `./sample-media` | 원본 루트. 컨테이너에는 `/media`로 읽기 전용 마운트 |
| `MEDIAVAULT_PORT` | `8080` | 호스트에 공개할 포트 (127.0.0.1 전용) |
| `AUTH_SECRET` | 자동 생성 | 비우면 `/data/secret.key`에 32바이트 시크릿 생성 |
| `COOKIE_SECURE` | `0` | HTTPS 뒤에 둘 때 `1` |
| `HWACCEL` | 비움 | `nvenc`면 GPU 인코딩 시도 |

개발 모드 추가 변수: `PORT`, `HOST`, `DATA_DIR`, `CACHE_DIR`, `WORKER_POLL_MS`.

### 기능 플래그

원본 파일을 바꾸는 기능은 기본값이 꺼져 있습니다.

| 변수 | 기본값 | 켜면 |
| --- | --- | --- |
| `FILE_MUTATION_ENGINE_ENABLED` | `0` | 영구 삭제·이동·`.rar` 추출이 실제 파일을 변경 |
| `HLS_GENERATIONS_ENABLED` | `0` | 세대별 HLS 게시와 교체 |
| `NOTIFICATIONS_ENABLED` | `0` | 알림 인박스와 Discord 전달 |
| `SEARCH_FTS_ENABLED` | `1` | trigram 검색 색인. 끄면 LIKE로 응답 |


> 기존 데이터베이스에 저장된 재생목록·스마트 앨범·일괄 작업의 이전 테이블은 마이그레이션 호환성과 데이터 보존을 위해 유지되지만, 화면/API/워커에서는 더 이상 사용되지 않습니다.

## 데이터와 백업

- **원본**: 기능 플래그가 꺼져 있는 한 손대지 않는다. 백업도 기존 방식 그대로 하면 된다. 삭제·이동을 켠 뒤에는 DB 백업이 원본 파일까지 되돌려 주지 않으므로, 파일 변경 이력은 `file_mutations`와 격리 디렉터리로 추적한다.
- **인덱스/캐시**: `/data`, `/cache` named volume. 캐시는 언제든 지워도 된다.

DB 백업은 `POST /api/backups`(설정 화면의 백업 버튼) 또는 `scripts/windows/backup-db.ps1`이 `VACUUM INTO`로 만들고 `integrity_check`로 검증합니다.
복원과 세션 초기화 절차는 [docs/RECOVERY.md](docs/RECOVERY.md)에 있습니다.
스캔은 idempotent라 DB를 잃어도 원본에서 그대로 다시 인덱싱된다(썸네일도 재생성).

## 동작 메모

- **스캔**: 파일 크기와 mtime이 같으면 건너뛴다. 바뀐 파일은 `file_version`을
  올려 썸네일 캐시 키를 갱신한다. 사라진 파일은 soft delete.
- **큐**: 미디어·ASR·번역·임베딩·장면·삭제·백업·정비·일괄 아홉 레인을 하나의 읽기
  모델로 보여주고, 저장은 파이프라인별 테이블로 나뉜다. 같은 작업의 중복 등록은
  partial unique index로 막고, 우선순위 `P0(지금 연 사진) → P4(선택)`에 2분마다
  한 단계 승격을 더한다. GPU 작업은 `gpu_leases`의 카드 리스를 공유한다. 실패는
  14개 안정 코드로 분류해 3회까지 재시도하고 `failed`로 남기며, 크래시로 남은
  `running` 작업은 워커가 시작할 때 복구한다.
- **검색**: 파일 이름과 대사는 FTS5 trigram 후보를 LIKE로 다시 확인하고, 3글자
  미만 질의는 항상 LIKE로 답한다. 장면은 모델 SHA·파이프라인 버전·차원이 같은
  임베딩만 쓴다. 색인은 build 행으로 기록되고, 실패한 재빌드는 이전 색인을
  그대로 둔다.
- **진단**: 모든 응답에 `X-Request-Id`가 붙고 JSON 오류에는 `requestId`, 5xx에는
  8자 `diagnosticId`가 들어간다. `/api/system/diagnostics`는 JSON과 Markdown을
  돌려주고 절대 경로를 가린다.
- **영상**: `mp4/m4v/mov/webm` + `h264/vp8/vp9/av1` + `aac/mp3/opus/vorbis`만
  Direct Play. 그 외는 4초 세그먼트 HLS로 변환해 캐시한다. 플레이어는 준비 중이면
  `202`를 받고 자동으로 재시도한다.
- **인증**: Argon2id 비밀번호 해시(기존 scrypt 해시는 로그인할 때 다시 해시),
  서버 세션 행과 불투명 토큰, `HttpOnly` + `SameSite=Strict` 쿠키 30일. 세션은
  DB 행을 지워 즉시 폐기할 수 있다. `/api/*`는 health/status/setup/login 외에
  세션을 요구하고, `/worker/*`는 워커 토큰을 쓴다.
- **경로 탈출**: 라이브러리 상대 경로는 항상 `MEDIA_ROOT` 안으로 해석되고,
  벗어나는 경로는 거부한다. nginx의 `/internal/*`은 `internal` 지시자로 외부
  접근이 차단된다.

## 문제 해결

| 증상 | 확인 |
| --- | --- |
| `port is already allocated` | `MEDIAVAULT_PORT` 변경 |
| 갤러리가 비어 있음 | 설정에서 라이브러리 등록 후 스캔했는지, `docker compose logs worker` |
| 영상이 계속 로딩 | HLS 변환 중일 수 있음. `docker compose logs -f worker` |
| 썸네일 404 | 원본 경로가 `/media` 아래인지, 파일 확장자가 지원되는지 |
| 로그인 후 바로 로그아웃 | HTTPS가 아니면 `COOKIE_SECURE=0` 유지 |
