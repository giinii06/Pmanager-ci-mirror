# MediaVault

개인 사진·영상 라이브러리. 원본 폴더는 **읽기 전용**으로 마운트하고, SQLite 인덱스와
썸네일 캐시만 따로 만들어 Apple Photos 스타일 갤러리로 보여준다.

- 사진: 320/640 WebP 썸네일 + 1600px 프리뷰를 미리 생성
- 영상: 브라우저가 재생할 수 있으면 Direct Play, 아니면(HEVC/MKV 등) HLS로 변환
- 자막(선택): 한국어 음성 인식 + 단어 단위 시간 정렬로 VTT/SRT 생성
- 웹은 원본 디스크를 직접 훑지 않고 인덱스만 조회. 무거운 작업은 별도 Worker
- 원본 이동·수정·삭제 없음. 캐시는 지워도 다시 만들어진다

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
| `api` | REST API, 세션, 썸네일 즉석 생성 | `/media:ro`, `/data`, `/cache` |
| `worker` | 스캔·변환 작업 큐 소비 | `/media:ro`, `/data`, `/cache` |

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

> 포트가 이미 사용 중이면 `.env`의 `MEDIAVAULT_PORT`를 바꾼다. 포트는 항상
> `127.0.0.1`에만 바인딩되므로 같은 PC 밖에서는 접근할 수 없다.

### GPU (선택)

NVIDIA 드라이버, WSL2 GPU 지원, [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)이
준비된 경우:

```bash
docker compose -f compose.yaml -f compose.gpu.yaml up -d --build
```

`HWACCEL=nvenc`로 H.264 인코딩을 시도하고, 실패하면 자동으로 `libx264`로
폴백한다. GPU가 없어도 모든 기능은 동작한다(느릴 뿐).

### AI 자막 (선택)

자막은 별도 Python 워커가 처리하며, 기본 스택에는 포함되지 않는다.
모델은 이미지에 넣지 않고 `asr-model-init` 컨테이너가 `./models`로 한 번만
내려받는다. 설치·운영 방법은 [docs/ASR-OPERATIONS.md](docs/ASR-OPERATIONS.md)를
따른다.

```bash
cp .env.asr.example .env.asr   # ASR_WORKER_TOKEN, 모델 커밋 SHA 채우기
docker compose -f compose.yaml -f compose.asr.models.yaml run --rm asr-model-init
```

- WSL2/NVIDIA: `compose.asr.cuda.yaml`을 추가해 GPU 컨테이너로 실행
- macOS: `compose.asr.mac-api.yaml`로 API만 띄우고 워커는 호스트에서 MPS로 실행
- 결과는 `./asr-results`에, 원본은 읽기 전용으로만 접근한다

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
| `bun test` | 단위 테스트 (큐, 커서 페이지네이션, 경로 탈출, 레이아웃) |
| `bun run smoke` | 실제 API+Worker를 띄우는 end-to-end 스모크 테스트 |
| `bun run typecheck` | 전체 워크스페이스 타입 검사 |
| `bun run sample` | 샘플 미디어 재생성 |

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

## 데이터와 백업

- **원본**: 손대지 않는다. 백업도 기존 방식 그대로 하면 된다.
- **인덱스/캐시**: `/data`, `/cache` named volume. 캐시는 언제든 지워도 된다.

DB만 백업하려면:

```bash
docker compose stop api worker
docker run --rm -v mediavault_mediavault-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/mediavault-data.tgz -C /data .
docker compose start api worker
```

복원은 같은 볼륨에 풀고 컨테이너를 다시 시작하면 된다. 스캔은 idempotent라
DB를 잃어도 원본에서 그대로 다시 인덱싱된다(썸네일도 재생성).

## 동작 메모

- **스캔**: 파일 크기와 mtime이 같으면 건너뛴다. 바뀐 파일은 `file_version`을
  올려 썸네일 캐시 키를 갱신한다. 사라진 파일은 soft delete.
- **큐**: `jobs` 테이블 + partial unique index로 같은 작업의 중복 등록을 막고,
  우선순위 `P0(지금 연 사진) → P4(선택)` 순으로 처리한다. 실패는 지수 백오프로
  재시도하고 3회 넘으면 `failed`로 남긴다. 크래시로 남은 `running` 작업은
  워커 시작 시 복구한다.
- **영상**: `mp4/m4v/mov/webm` + `h264/vp8/vp9/av1` + `aac/mp3/opus/vorbis`만
  Direct Play. 그 외는 4초 세그먼트 HLS로 변환해 캐시한다. 플레이어는 준비 중이면
  `202`를 받고 자동으로 재시도한다.
- **인증**: scrypt 비밀번호 해시, HMAC-SHA256 세션 토큰, `HttpOnly` +
  `SameSite=Strict` 쿠키 30일. API의 모든 경로는 health/status/setup/login 외에
  세션을 요구한다.
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
