# Pmanager / MediaVault 최종 구현 명세서 v1.0

> **입력 고정:** `Pmanager-main-2(1).zip` (SHA-256 `dc556a5f6d4112a60dd261a6c7dadbf52f5a2d7da50989bf48cb9147d3ef9993`), 2026-11-19. 이 문서는 **구현 계획**이며 ZIP 속 실제 코드를 수정한 결과가 아니다. 아래의 경로는 ZIP 기준 상대 경로다. 선행 리뷰에서 이미 제시된 개선안, 추가 조사, 이번 ZIP 직접 확인 결과를 합쳐 구성했다.
>
> **영구 제외:** (a) AI 자동 챕터 생성, (b) 자막 편집기/자막 편집 버전 관리, (c) 이미지 입력 기반 유사 장면 검색. 기존 ASR·번역·자막 표시 및 텍스트 기반 장면 검색은 보존/안정화한다.
>
> **목표 실행 환경:** Windows 11 + Ubuntu 24.04 WSL2 + WSL 내 Docker Engine + RTX 5060 Ti 8GB + macOS 원격 접속. Linux 단일 서버도 지원. 기존 동작 중인 데이터, 볼륨, 사용자 설정, 폴더/자산 ID, Vote·조회수·시청 기록, 30일 세션의 사용자 경험은 전환 기간 동안 호환 유지.

## A. 구현 불변식과 범위

### A-1. 바꾸지 않을 기반
- Bun/Fastify/SQLite WAL `synchronous=FULL`/React/TanStack Query/Zustand/FFmpeg/Sharp/Python AI 워커를 유지한다. 기존 개별 `jobs`, `asr_jobs`, `translation_jobs`, `embedding_jobs`, `scene_jobs`도 즉시 통합·재작성하지 않는다.
- Redis, PostgreSQL, Temporal, BullMQ, Qdrant를 필수로 설치하지 않는다. FAISS는 측정 기준 충족 시 **재생성 가능한 보조 인덱스**로만 도입한다. 데이터베이스를 단일 원장으로 유지한다.
- `asset_id`, `library_id`, `file_version`, 태그, Vote 이벤트, 리뷰, 재생 이력, 모델 추론 결과를 파괴적으로 초기화하지 않는다. 최초 업그레이드는 가산식(additive) migration 우선.
- `/media`, `/media/extra`, `/media/drives/{c,d,e}`의 현재 네임스페이스와 유효한 기존 DB `libraries.root_path`를 보존한다. Windows 부팅 감독자 `scripts/windows/service-runner.ps1` 및 systemd Docker/SSH 흐름은 유지한다.
- 기존 Rate의 숫자 정의를 갑자기 바꾸지 않는다. 향후 '완주율/인기도'는 새 지표로 분리하고 기존 정렬은 보존한다.

### A-2. 위험도가 높은 처리의 금지 규칙
1. **원본 파일은 자동 중복 삭제 금지.** 유사 영상/이미지 검출도 후보 제시만 하며 사용자 승인 없이 파괴적 작업 불가.
2. **드라이브 미연결/권한 문제/읽기 오류/마운트 정체는 삭제 사건이 아님.** 어떤 `SCAN_DELETE_FORCE` 플래그도 마운트 안전 검사 우회 금지.
3. **DB 트랜잭션은 파일 시스템 변경까지 원자화하지 못함.** 삭제/이동/압축 해제/HLS 게시에는 내구성 있는 작업 로그와 재조정 필수.
4. **작업 리스가 만료된 워커의 결과 공개 금지.** `lease_epoch`, `worker_id`, `file_version`, `model_fingerprint`를 결과 승인 시 재확인.
5. **외부 도구/브라우저/API의 실패는 부분 성공일 수 있음.** 클라이언트 재전송으로 조회수·재생 시간·삭제·Vote가 중복 실행되어서는 안 됨. 단, 기존 Vote UX는 매번 별도 클릭 시 영구 누적하는 방식을 유지.
6. 복구 불가능한 자동 복구를 금지한다. 시스템이 모호하면 자산 보류/격리 후 사용자에게 보고한다.

### A-3. 기존 시스템 코드 앵커
| 모듈 | 기준 소스의 실제 엔트리 |
|---|---|
| 스키마 | `packages/database/src/schema.ts`, 현재 `SCHEMA_VERSION = 15`, `MIGRATIONS` 배열 |
| DB 연결·마이그레이션 | `packages/database/src/db.ts`, `openDatabase()` |
| 일반 미디어 작업 | `packages/database/src/jobs.ts`, `apps/worker/src/loop.ts`, `apps/worker/src/handlers.ts` |
| 복구·스캔 | `apps/worker/src/recovery.ts`, `apps/worker/src/scan.ts`, `packages/database/src/scan-runs.ts` |
| GPU 리스 | `packages/database/src/gpu-leases.ts`, `apps/worker/src/gpu.ts`, AI worker API 라우트 |
| 영구 삭제 | `apps/api/src/routes/assets.ts` 및 `packages/database/src/assets.ts` |
| 미디어 전송/HLS | `apps/api/src/routes/media.ts`, `packages/media/src/hls.ts`, `packages/media/src/paths.ts` |
| 통합 작업현황 | `packages/database/src/work-queue.ts`, `packages/shared/src/domain.ts`, `apps/web/src/components/ProcessingPanel.tsx` |
| 인증 | `apps/api/src/auth.ts`, `apps/api/src/routes/auth.ts`, `apps/api/src/app.ts`, `packages/database/src/users.ts` |
| 웹 API·뷰어 | `apps/web/src/lib/api.ts`, `apps/web/src/store/viewer.ts`, `apps/web/src/components/VideoPlayer.tsx` |
| 배포·운영 | `compose*.yaml`, `.env*.example`, `scripts/windows/*.ps1`, `deploy/nginx/default.conf` |

## B. Phase 0: 데이터와 배포의 안전성 [반드시 가장 먼저]

### B-01. 파일 삭제의 완전한 상태 기계
**현재 확인:** `apps/api/src/routes/assets.ts`는 `getAssetDeletePlan` 이후 `unlinkStrictMediaFile`을 **동일 상대경로로 두 번 호출**한 뒤 `commitPermanentDelete`를 수행한다. `libraryRoot`가 없거나 `resolveInside()`가 실패해도 삭제 확정 코드로 진행할 수 있다. 원본 삭제와 DB 삭제 사이 종료 시 불일치 가능. 캐시 정리는 오류를 삼키는 처리도 있다.

**결정:** API는 직접 파일을 지우지 않고 `mutation-worker`에 영구 작업을 등록한다. UI의 '영구 삭제' 의미는 유지하지만 **즉시 완료로 거짓 표시하지 않는다.** `202 Accepted + operationId`를 반환하고 완료 확인 후 목록에서 영구 제거한다. 기존 동기 `204` API와 호환이 필요한 경우 한 전환 릴리스 동안 클라이언트를 함께 배포한다.

**상태:** `requested -> validated -> quarantined -> db_committed -> purging -> completed` 및 `failed_retryable`, `blocked`, `cancelled_pre_commit`.
- 요청은 `user_id/asset_id/file_version/client_request_id`를 서버에서 검증하고 유일한 `mutation_id`를 생성한다. 같은 요청 ID는 같은 결과를 반환한다.
- 검증 시 (a) DB의 정확한 자산/라이브러리, (b) 등록된 루트 실제 경로, (c) `lstat`로 symlink 여부, (d) `stat`의 식별자·크기·mtime, (e) 라이브러리 ONLINE 상태, (f) 파일 버전 일치를 확인한다. 문자열 `resolveInside`만으로 경로 안전을 보장한다고 가정하지 않는다.
- **원본과 같은 파일 시스템**의 루트 밖 전용 격리 디렉터리를 명시적으로 운영한다. 같은 볼륨의 rename 성공 시 격리 파일의 고유 이름을 매니페스트에 기록. 교차 볼륨인 경우 단순 rename은 원자적이지 않으므로 별도 copy→hash verify→commit 전략 사용; 기본 삭제 기능에서는 교차 볼륨 격리를 금지하고 해당 라이브러리 볼륨의 격리를 요구한다.
- 격리 상태에서 일반 목록/검색/재생에서 삭제 예정 자산을 숨긴다. DB 외래키를 조기 연쇄 삭제하지 않으며 기존 조회수·Vote·태그가 잘못 유실되지 않도록 삭제 단계 구분. `commitPermanentDelete`는 최종 확정 단계에서 기존 정리와 동일한 관계를 처리한다.
- 격리된 파일이 없어졌으나 DB가 미완료이면 원본 상태와 작업 매니페스트를 비교하고 `blocked`로 보내며 위험한 추측 삭제를 금지한다.
- 디스크 영구 삭제는 재조정/확인 후 실행하고, 원본과 캐시 정리 오류를 따로 기록한다. 영구 삭제가 완료된 후 과거 조회 ID는 `404` 또는 `410`으로 통일.
- ZIP에 있는 중복 `unlinkStrictMediaFile` 호출은 **즉시 제거**한다. `libraryRoot`/경로 검증 실패는 작업 확정 금지.

**데이터 제안:** `file_mutations(id, kind, asset_id, library_id, requested_file_version, request_key UNIQUE, state, source_rel, quarantine_rel, manifest_json, attempts, lease_epoch, lease_owner, lease_expires_at, error_code, created_at, updated_at, completed_at)`, `mutation_events(id, mutation_id, state, payload_redacted, created_at)`. 위험한 조작은 운영자 승인 여부 저장.

**API:** `POST /api/assets/:id/delete-operations`(idempotency key 필수), `GET /api/file-operations/:id`, `POST /api/file-operations/:id/retry`. 기존 `DELETE /api/assets/:id`는 새 API로의 전환을 위해 호환 shim으로 유지할 수 있으나 **직접 unlink 금지**. 응답에는 작업 ID와 현재 상태를 포함.

**신규 파일:** `packages/database/src/file-mutations.ts`, `apps/worker/src/mutations/{delete,move,reconcile}.ts`, `apps/api/src/routes/file-operations.ts`, `apps/worker/src/mutation-worker.ts`(또는 기존 루프 내 별도 실행 역할). 실제 파일 변경만 가능한 서비스로 권한 분리.

**테스트:** 파일 삭제 직후·격리 직후·DB 커밋 직후·최종 삭제 직후 각각 SIGKILL; 경로 변경, symlink 대체, 중복 요청, 다른 라이브러리, 미연결 드라이브, 권한 오류, 디스크 부족. DB 자산과 원본 파일/격리 파일의 관계가 모든 단계에서 일관되게 재조정되는지 확인. 격리와 원본이 모두 사라졌을 때 아무 추정 작업도 하지 않음.

### B-02. Docker Compose 마운트 안전성
**현재:** `compose.yaml`의 다수 볼륨은 `${DRIVE_D_ROOT:-./sample-media}:/media/drives/d` 같은 짧은 문법과 샘플 경로 기본값을 사용. 운영 환경에서 경로 누락이 빈 디렉터리로 대체될 위험.

**결정:** 운영 Compose에서는 `type: bind`, `bind.create_host_path: false` 사용, 모든 **활성 드라이브**에 실제 지정된 경로를 필수로 요구한다. 샘플 미디어는 `compose.dev.yaml`로만 분리. optional 드라이브는 각자 프로파일/별도 override에 넣고, 설정되어 있지 않으면 등록되지 않도록 한다. 기존 데이터의 `/media/extra`, `drives/c,d,e` 경로는 바꾸지 않음.

**경로 제약:** 하위 `/media/extra`/`/media/drives/*`의 바인드 마운트가 상위 `/media`와 겹치는 기존 네임스페이스를 고려하여 Compose 최종 렌더링 검사(`docker compose config`)를 필수화. C/D/E가 모두 있는 경우 기존 마운트 목록과 정확히 동일한 컨테이너 경로로 재현.

**Preflight:** 루트 존재, 디렉터리 타입, 실제 read 테스트, 라이브러리 안전 마커(운영자 승인 후 생성한 마커/고정 경로 매핑), 장치 식별, 자유 공간, Docker 장치 인식 확인. 미연결이면 `up` 실패 또는 해당 라이브러리 `OFFLINE` 처리. 샘플 경로를 운영 드라이브 대신 자동 사용 금지.

**수정 위치:** `compose.yaml`, `compose.asr.cuda.yaml`, `compose.scene.cuda.yaml`, `.env.example`, `scripts/windows/service-runner.ps1`, `scripts/windows/_common.ps1`, 새 `scripts/preflight.ts` 및 Windows preflight 호출. 인증된 정보 없는 Docker 서비스가 권한 없이 다른 운영 드라이브를 읽는 것도 금지.

### B-03. 스캔에서 디스크 장애와 실제 누락 분리
**현재:** `scan.ts`에는 `lstat`/`realpath`/빈 마운트·`readErrors` 방어, 재개 후 전체 검증 패스가 이미 있다. 따라서 기존 보호 장치를 제거하지 않는다. 다만 `threshold = Math.max(50, Math.floor(total*ratio))`는 소규모 라이브러리 누락을 허용할 수 있다.

**결정:** `library_health`를 `ONLINE/DEGRADED/OFFLINE/UNVERIFIED`로 저장. `scan_runs`에 마운트 식별 정보, 읽기 오류 수, 누락 수·누락 비율, 검증된 전체 순회 여부를 저장. OFFLINE/DEGRADED/UNVERIFIED/경계 식별 변경/읽기 오류면 `softDeleteMissing` 절대 불가.
- 1차 발견+인덱스 등록은 기존 체크포인트 구조 유지, **2차 authoritative verify**가 마운트 상태와 함께 성공했을 때만 누락 재조정.
- `missing>0 && total<=50` 등 작은 라이브러리에서 비율 경고를 실제 적용. `missingRatio >= 0.2` 또는 과도한 절대 삭제 수 등 정책은 환경설정으로 두되 루트 전체 소실은 개수 무관 무조건 차단.
- `SCAN_DELETE_FORCE=1`은 정상 ONLINE 루트에서 명시적 대량 정리 승인을 위한 한정 플래그로만 허용; 마운트/읽기 안정성 검사 우회 금지. 가능하면 삭제 force는 API로 승인한 일회성 토큰으로 대체.
- 중복 스캔 실행 경쟁, 루트 변경, 시스템 디렉터리/다중 볼륨 경계도 기존 테스트 보완.

**스키마:** `library_health(library_id PRIMARY KEY, state, root_identity, last_success_at, last_error_code, checked_at, consecutive_failures)`; `scan_runs` 확장(정상 검증 여부·누락 총량·health snapshot).

**UI:** 설정 > 라이브러리 상태 카드. OFFLINE 상태는 검색 결과의 삭제 표시가 아니라 `원본 저장소 연결 끊김`으로 안내하며 자동 복구 재시도만 수행.

### B-04. 비밀값·빌드 컨텍스트·접근권한
**현재:** `.gitignore`에서 `.env.scene` 제외 누락, `.dockerignore`에서 `.env.*` 제외 누락. nginx의 `/internal/media`는 `internal`로 보호되어 있음.

**결정:** 두 ignore 파일에 `.env`, `.env.*`를 무시하고 `!.env.example`, `!.env.*.example` 예외 등록. `git ls-files`로 실제 추적 여부 확인, 기존 비밀 노출이 의심되면 모든 워커 토큰 교체. `.env`를 생성하는 PowerShell 스크립트도 제한된 ACL 적용.
- Dockerfile에 secret이 COPY될 가능성 차단, 이미지 빌드 컨텍스트 감사; 작업 로그에서 토큰과 쿠키 제거.
- 운영 서비스 역할: `api:ro`, `scanner:ro`, `ai workers:ro`, `web/nginx:ro`, 파일 변경 전담 mutation worker에만 제한적 `rw`. 기존 아카이브 추출은 현재 워커에서 원본에 쓰므로 새 mutation 역할로 옮긴 **후** 일반 워커를 ro로 바꿔야 한다.
- 루트 프로세스 제거와 컨테이너 capabilities 축소는 런타임/디렉터리 권한 검증 후 단계적으로 진행. AI GPU 드라이버, Nginx의 파일 읽기 권한에 영향 없는지 확인.

### B-05. ASR·Scene 추가 드라이브 접근
**현재:** `compose.asr.cuda.yaml`/`compose.scene.cuda.yaml`은 `/media`와 `/media/extra`만 마운트. 기존 C/D/E 자산은 API에 등록되어도 AI 워커에서 열리지 않을 수 있다. 반면 번역·임베딩 워커는 원본 영상 경로를 직접 읽지 않는 구조이므로 단순 일괄 마운트 불필요.

**결정:** ASR·scene worker에 기본 Compose와 같은 컨테이너 내부 경로의 `/media/drives/{c,d,e}:ro`를 추가(활성 드라이브에 한함). `MEDIA_ROOT=/media` 유지. `realpath`/루트 경계 검증 적용. C/D/E 자산을 각 하나씩 포함한 통합 테스트를 수행하고 모델 초기화 이후 실제 경로 확인.

### B-06. 외부 서비스 없이 안전한 백업/복원
**현재:** `packages/database/src/backup.ts`의 `VACUUM INTO` + `integrity_check` 기반과 14개 보존, `apps/worker/src/loop.ts`의 일간 자동 백업은 이미 존재. `POST /api/backups`는 API 안에서 동기 호출함. `restoreDatabaseBackup`은 DB 연결 종료를 자체 보장하지 않음.

**결정:** 백업은 작업으로 enqueue 후 `202 + jobId`; 별도 DB 백업 실행 컨텍스트에서 만들고 `/api/backups/:id`로 상태 조회. 기존 자동 백업 스케줄과 병합하고 같은 시점 중복 백업 방지. 중복 백업은 불필요하게 WAL/디스크를 압박하지 않도록 중복키 사용.
- 백업 파일의 완성 표시/크기/스키마/integrity/hash/생성 시각/원본 DB 버전을 manifest에 저장. 파일과 DB의 로그 양측 상태를 재조정 가능하게.
- 스케줄: 매일 한 번(기존 정책), 최근 14개 + 선택적 주간/월간. 성공 검증 전 기존 백업 삭제 금지. 실제 보존량 설정은 디스크 여유와 백업 크기에 따라 제한.
- 복원: 앱 내부 API로 즉시 덮어쓰지 않는다. 운영자만 사용 가능한 **별도 restore CLI**를 실행하고 API/워커/AI 워커 등 DB 접근 프로세스 전체 정지 확인 후 수행. 운영 중 생성된 `-wal`, `-shm` 잔존 파일을 올바르게 처리하고 대상의 이전 DB를 별도 격리. 스키마 마이그레이션/스모크 테스트 실패 시 이전 파일로 복귀.
- 백업 복원 리허설은 임시 DB 경로로 복원·`integrity_check`·FK 검사·행 수·스키마·검색/태그/설정 필수 조회를 수행하며 운영 DB에는 변경 없음.
- DB만 아니라 `.env.*`/AI 모델 매니페스트/자막·번역 결과/원본 미디어의 **포함·제외 범위**를 명시. 원본 파일 전체를 DB 백업과 혼동하지 않도록 UI에 별도 표기.

**파일:** `packages/database/src/backup.ts`, `apps/worker/src/loop.ts`, `apps/api/src/routes/system.ts`, 새 `scripts/restore-db.ts`, `scripts/verify-backup.ts`, `docs/BACKUP-RESTORE.md`; Windows `backup-db.ps1` 갱신.


## C. Phase 1: 미디어·재생의 정합성

### C-01. HLS 원자적 게시, 오래된 워커 펜싱, 활성 재생 보호
**현재:** `packages/media/src/hls.ts`에서 `rm(finalDir)` 후 `rename(tmpDir, finalDir)`; `apps/worker/src/handlers.ts`의 thumbnail은 `canPublish` 검사가 있으나 preview/HLS는 동등하지 않음. `routes/media.ts`는 현재 `hlsDir(cacheDir, assetId, fileVersion)`에 고정된 `master.m3u8`와 `seg#####.ts`를 제공한다.

**결정:** HLS는 **immutable generation** 구조로 바꾼다. 경로: `/cache/hls/<assetId>/v<fileVersion>/g/<generationId>/master.m3u8`와 세그먼트. 변환 파라미터(codec/profile/encoder/preset/scale/audio), 원본 버전, 작업 리스 등을 `hls_generations`에 저장한다.
- 작업 시작 시 고유 임시 폴더에 인코딩하고 `-progress pipe:...`로 진행률을 수집한다. 사용 중 리스·asset 파일 버전·작업 상태 검사 실패 시 공개하지 않고 삭제/격리.
- FFmpeg exit code=0만 검사하지 않고 playlist 내 세그먼트 존재, 예상 개수·최소 크기, 파일 읽기, 디스크 공간을 검사한 후 같은 볼륨에서 완성 디렉터리 공개. DB의 `active_generation_id`는 별도 트랜잭션으로 교체.
- **핵심:** HLS 플레이리스트는 고유 generation ID를 포함한 세그먼트 URL을 제공해야 한다. 단순히 '현재 generation'으로 세그먼트를 조회하면 플레이리스트가 만들어진 뒤 세대가 교체되었을 때 404/다른 결과가 섞일 수 있다.
- 공개 API: `GET /api/assets/:id/hls`(preparing/ready/failed), 준비 완료 시 `playlistUrl=/api/assets/:id/hls/g/:generationId/master.m3u8`; `GET /api/assets/:id/hls/g/:generationId/:file`(권한+asset ID+버전+세대 일치 검증). 기존 `/api/assets/:id/hls/master.m3u8`는 새 준비/리다이렉션 adapter로 전환; 예전 플레이어는 일시적으로 호환.
- 활성 세대가 바뀌어도 이전 세대는 정해진 보호 기간 동안 보관하고 비활성 여부/최근 접근 시각/공간 한도로 GC. 재생 중 진짜 사용 여부를 알기 어려우므로 안전 TTL과 grace period 사용.
- NVENC 작업이 `AbortSignal`로 종료된 경우 CPU 폴백 금지. GPU 인코딩 자체가 불가능한 것으로 판정된 경우에만 제한적으로 CPU 폴백하되 초반 실패 원인을 기록. 시도 사이 부분 세그먼트를 청소.
- 이미지 preview의 `ensurePreview`에도 thumbnail과 같은 file_version+fence publish guard 적용. 직접 API에서 생성하는 이미지 프리뷰/포스터 요청에도 동시성 버전 검사를 추가.

**스키마:** `hls_generations(id PK, asset_id, file_version, profile_hash, state, playlist_rel, job_id, worker_id, lease_epoch, created_at, published_at, expires_after, last_access_at, error_code)`, `hls_active(asset_id, file_version, profile_hash, generation_id, PRIMARY KEY(...))`.
**파일:** `packages/media/src/hls.ts`, `paths.ts`, `apps/worker/src/handlers.ts`, `packages/database/src/hls.ts`(신규), `apps/api/src/routes/media.ts`, `VideoPlayer.tsx`, `deploy/nginx/default.conf`.
**검증:** 두 워커 동시 HLS 작업, 인코딩 도중 종료, 원본 변경, playlist 조회 직후 세대 변경, 세그먼트 읽기 중 GC, GPU 리스 만료, 재시도 후 화질/길이 유지.

### C-02. HLS 준비·오류·재시도 상태 API
현재 HLS GET은 없으면 `202 {state:'preparing'}`를 주고, 웹은 2초 주기로 재요청. 작업 영구 실패 시 무한 준비 화면 가능.
- 준비 API를 `queued/running/ready/failed/retry_wait/cancelled/source_offline` 상태로 제공. JSON에 `jobId`, `stage`, `progressPercent`, `retryAfterSeconds`, `errorCode`, `message`, `playlistUrl`(ready일 때만) 포함.
- HTTP 정책: 준비 `202` + `Retry-After` + `Cache-Control: no-store`; ready `200`; 원본 미연결 `503`; 영구 오류 시 상태 조회 `200 {state:failed}` 또는 명확한 오류 HTTP 상태로 일관되게 설계. 세그먼트 URL은 `404/410`을 정확히 구분.
- 웹에서는 제한된 시간과 횟수로 상태 조회, 오류를 사용자에게 보여주고 **재시도 버튼** 제공. 요청 취소·컴포넌트 해제 시 fetch 중단. hls.js error type별 네트워크/미디어 복구는 지수 백오프와 횟수 제한.

### C-03. 미디어 재생 전략과 메타데이터
- `packages/media/src/probe.ts`, shared `AssetDTO`, `toAssetDTO`, `apps/web/src/components/VideoPlayer.tsx`를 함께 수정.
- 출력 선택 순서: `direct play -> remux/direct stream -> audio-only transcode -> HLS full transcode`. 브라우저 `canPlayType`와 `MediaCapabilities.decodingInfo`가 지원되는 환경에서는 정밀 판정, 불확실하면 실제 재생 실패 후 폴백. `MediaCapabilities`는 지원되지 않을 수 있으므로 필수로 가정 금지.
- 현재 스키마의 `video_codec/audio_codec/container`만으로 부족하면 `media_tracks` 또는 `assets`의 JSON metadata 컬럼으로 비트 깊이/HDR/프로파일/오디오 채널/해상도/회전 정보를 저장. 원본을 다시 ffprobe할 때만 갱신.
- 선택적 remux 출력은 HLS와 동일하게 세대별 캐시 및 용량 정책 적용. 처음부터 모든 영상을 여러 비트레이트로 사전 변환하지 않음.
- NVIDIA는 `ffmpeg -encoders/-decoders` 및 실제 짧은 샘플 인코딩으로 지원 여부 확인. GPU 리스에 속한 FFmpeg만 GPU 접근. `-progress pipe:1`는 별도 구조화 출력으로 읽고 stderr는 크기 제한하여 진단 정보만 보관.

### C-04. 뷰어 비동기 요청 및 전체 목록 탐색
**현재:** `apps/web/src/store/viewer.ts`의 `open()`에서 비동기 `assetIds`를 받아 `poolIds`를 갱신하며, `navigateRandom()`도 비동기 응답이 현재 뷰어와 일치하는지 충분히 검증하지 않음. 순차 `next/prev`는 현재 `items` 배열의 끝에서 멈춤.
- 상태에 `viewerSessionId`(단조 증가 정수/UUID), `navigationRequestId`, `filterSignature`, `currentAssetId`, `cursorPosition` 추가. open/close/filter 변경 시 새로운 session, 이전 controller abort.
- 비동기 fetch 결과 반영 직전 session/request/filter/asset context 재검증; stale 결과 무시. `loadingNext` 또한 해당 요청 소유권 일치 시에만 해제.
- 순차 이동은 서버의 `GET /api/assets/:id/neighbor?direction=next|prev&filter=...&sort=...`와 일치하는 정렬 키로 처리. 필터 일관성·동일 값 tie breaker `id` 필수. 한 번에 모든 ID를 내려받지 않음.
- 셔플 API `POST /api/assets/random`은 필터 조건·현재 자산·최근 재생 목록·seed(optional)을 받아 하나의 자산 또는 204를 반환. 전체 목록 `ORDER BY RANDOM()` 및 20,000 ID 조회 대신 필터에 맞는 균등 후보 샘플링/사전 무작위 키로 구현. 동일 필터에서 전체 항목이 반복 없이 무한정 순회되어야 한다고 약속하지 말고 최근 N개 반복 최소화와 균등성 테스트 적용.
- 기존 `/api/assets/ids`는 전환 호환성 유지 후 미사용이면 제거하며, 데이터 규모 크면 응답할 수 없는 제한을 UI에서 명확히 표시.

### C-05. 이어보기 위치의 결정 규칙
**현재:** 저장 위치를 비동기로 받아 `startAt.current`에 쓴 뒤, `loadedmetadata`에서만 적용. 사용자가 직접 지정한 `startMs`가 항상 이기도록 기존 시도를 유지하되 late response 문제 해결.
- 탐색 우선순위는 `사용자가 명시한 startMs > 현재 세션에서 직접 seek한 위치 > 이전 재생 기록`. `assetId/fileVersion/viewerSessionId`가 일치하는 기록만 사용.
- `loadedmetadata`가 먼저 발생해도 기록 도착 시 video metadata 준비 여부로 즉시 적용. 같은 소스에 대해 1회만 적용한 이후에는 뒤늦게 도착한 응답으로 사용자 seek를 덮지 못하도록 상태 머신 사용(`pending/ready/applied/ignored`).
- source 전환, Direct→HLS 전환, 모달→WatchPage 전환, 영상 종료 근처, Safari metadata 지연 시나리오 검사.

### C-06. 재생 시간·조회수 멱등 집계 및 회귀 없는 Vote
**현재:** `POST /api/assets/:id/view`, `/watch-time`은 매 요청에서 카운트 증가. 웹에서 응답 유실 후 재시도하면 같은 시간을 이중 집계할 수 있음. `playback_progress`는 `(user_id,asset_id)` upsert로 마지막 요청이 덮어씀.

**새 계약:**
- `POST /api/play-sessions` -> `{sessionId, assetId, fileVersion, issuedAt}`. 각 재생 시작에 1회 등록하고 `play_session_id UNIQUE`로 첫 실제 `playing`에서 조회수 이벤트 1회 기록. 여러 번 재생한 경우 명시적으로 새 세션 생성할 수 있어야 기존 조회수 의미 유지.
- `POST /api/play-sessions/:sessionId/events`의 payload `{eventId, seq, type:'watch_time'|'progress'|'view', deltaMs?, positionMs?, durationMs?, clientTimestamp?}`. `eventId` 중복은 성공 응답만 반환, 집계 재적용 금지. `eventId` 유일 인덱스 + 집계 갱신을 같은 SQLite 트랜잭션으로 처리.
- `watch_time`은 실제 재생 중의 경과 시간만 누적. seek/waiting/stalled 일시 중단 제외. 같은 플레이어에서 동시에 실행 중인 flush들을 순서화하고 네트워크 실패 시 **같은 eventId**로 재전송. 서버에서는 per-session 증가/단조 `seq` 검증. 이벤트 합계는 장시간 반복 실행 시에도 중복 반영 불가.
- `progress` 업데이트는 per-session 최신 seq 및 `updated_at` 버전 비교 후에만 저장. 같은 이벤트의 retry나 오래된 응답이 신규 위치를 덮지 못하도록 함. 여러 기기에서 같은 영상 재생 중인 경우 진행률 충돌 정책(`latest accepted server event`)을 정의.
- `visibilitychange(hidden)`, `pagehide`, unmount의 중복 flush도 동일 사건으로 합쳐야 함. `sendBeacon`/`fetch keepalive`는 성공 확인이 없을 수 있으므로 멱등성이 필수.
- `Vote`는 여러 클릭을 각각 고유 이벤트로 기록하며 영구 누적하는 기존 의미 유지. UI 더블클릭 accidental 방지와 네트워크 retry idempotency를 위한 `clientRequestId` 지원 **그러나 다른 실제 클릭은 합치지 않는다**.

**스키마:** `play_sessions(id, user_id, asset_id, file_version, started_at, ended_at, view_recorded_at, last_seq)`, `play_events(event_id PRIMARY KEY, session_id, seq, event_type, delta_ms, position_ms, recorded_at, UNIQUE(session_id,seq))`; `playback_progress`에 적용된 서버 이벤트 버전 추적 컬럼 등 추가.
**전환:** 기존 조회수/시청 시간·기록을 유지하고 `view_count/watch_time_ms`에 새 이벤트만 가산. 이전 API는 단계적으로 deprecated 후 전환 클라이언트가 정상 작동하는 동안은 호환 유지. 재생 관련 통합 테스트가 완료되기 전 구 API 제거 금지.

### C-07. UI에서 삭제된 자산의 캐시 일관성
- 삭제/이동/태그 변경/투표/리뷰/앨범 적용 성공 후 TanStack Query의 해당 자산, 목록, 필터, 검색, 관련 영상, 뷰어 상태를 정확히 invalidation/patch. 느린 요청 응답이 삭제된 자산을 다시 복원하지 못하도록 mutation epoch 사용.
- 404/410/503(source_offline)의 UX를 분리: 영구 삭제됨 vs 드라이브 끊김. 영상 전환 도중 포스터·HLS stale URL로 원본을 재생하지 않도록 `fileVersion` 확인.


## D. Phase 2: 작업 큐·GPU·AI 처리 엔진

### D-01. 모든 작업을 하나의 ProcessingPanel에 표시
**현재:** `packages/database/src/work-queue.ts`의 `WorkPipeline`에는 `media/asr/translation/embedding`만 존재. `scene_jobs`는 별도 실제 테이블이 있으나 통합 조회·전체 ETA/실패 현황에서 빠짐. `packages/shared/src/domain.ts`도 4종 타입.
- `WorkPipeline = 'media'|'asr'|'translation'|'embedding'|'scene'|'backup'|'maintenance'|'mutation'|'bulk'`로 **표시용** 타입 확장. 실제 작업 저장 테이블은 우선 유지.
- `workQueue`에 `scene_jobs` SELECT/COUNT/최근 완료·실패 필터/최근 처리시간 계산/리스 onGpu 여부 추가. `scene` 단계의 `queued/indexing/writing/...` 실제 enum은 `packages/shared`에서 확인하고 그대로 매핑. `scene`의 `max_windows` 샘플링 정보 및 커버리지도 표시.
- 여러 큐의 시간을 합산할 때 **동시 GPU 작업을 1개로 제한한다는 실제 스케줄 정책**과 CPU 미디어 작업 병행 가능성을 반영. `media`라고 모두 CPU인 것은 아님(HLS NVENC/transcode가 GPU를 사용 가능): ETA 계산을 `pipeline` 구분만으로 결정하지 말고 리소스 요구에 따라 계산.
- `ProcessingPanel`은 큐에 등록된 전체 개수, 실행 중, 리소스 대기, 다음 재시도, 실패 원인, ETA 범위, 작업 우선순위, 파일별 진단 링크를 제공. 실패 후 최신 재시도가 성공한 경우 오래된 실패 행을 활성 실패로 보여주지 않음.

### D-02. GPU 공통 자원 정책
**유지:** 기존 `gpu_leases`의 리스 소유자/최근 해제/작업군 교대 정책. VRAM 8GB에서는 기본 GPU 추론/인코딩 작업 **동시 실행 1개**.
- `gpu_resource` 할당 시 작업 우선순위: 사용자 재생/요청 작업 > 사용자가 강제 실행한 AI > 신규 자산 처리 > 전체 라이브러리 backfill. 단, 오래 대기한 작업을 자동으로 승격해 starvation 방지.
- `waiting_gpu`와 `running_gpu`를 분리; GPU 대기 중인 작업의 완료 ETA에 모델 로딩 시간과 현재 작업 잔여 시간 포함. 현재 lease는 단지 '소유 중'일 뿐 VRAM 안전을 증명하지 않으므로 모든 GPU 프로세스의 실제 메모리 및 종료를 함께 확인.
- 모델 전환 비용 완화를 위해 같은 모델을 작은 그룹으로 배치할 수 있으나 다른 작업군의 기아를 막는 최대 묶음 길이 설정. 우선 default는 현행 모델 프로세스 생성·해제 방식 유지.
- OOM 발생 시 작업 종류에 따라 배치 수/청크 크기 축소 가능한 경우만 제한 재시도. 같은 설정으로 무한 재시도 금지. 모델이 해제되지 않는 프로세스가 있을 경우 관리자 경고 및 다음 작업 보류.
- GPU 의존성 없는 scene text query 서버는 기존처럼 CPU에서 독립 수행; 사용자가 검색하는 동안 GPU 분석을 멈추지 않음.

### D-03. 공통 작업 오류 코드와 회복 정책
- 표준 코드: `SOURCE_OFFLINE`, `SOURCE_NOT_FOUND_CONFIRMED`, `SOURCE_CHANGED`, `FILE_CORRUPT`, `PERMISSION_DENIED`, `DISK_FULL`, `GPU_OOM`, `GPU_LEASE_LOST`, `MODEL_MISSING`, `MODEL_SHA_MISMATCH`, `PROCESS_TIMEOUT`, `PROTOCOL_MISMATCH`, `USER_CANCELLED`, `INTERNAL`.
- `SOURCE_OFFLINE`, `DISK_FULL`은 환경 회복 전까지 재시도 중지; `SOURCE_CHANGED`는 새 파일 버전으로 재생성; `MODEL_SHA_MISMATCH`는 사용자/운영자가 검증 전까지 차단; `GPU_OOM`은 허용된 재설정 범위에서만 재시도. 비정상 입력은 제한된 실패 횟수 후 격리.
- 실패 메시지는 사용자가 이해할 수 있는 텍스트와 개발자용 진단 ID를 분리. API 응답에 시스템 전체 파일 경로나 토큰 노출 금지.
- 취소 시 하위 `ffmpeg` 또는 모델 서버의 실제 종료 완료를 확인해야 다음 GPU 작업을 안전하게 시작할 수 있다.

### D-04. AI 단계별 체크포인트 및 두 단계 게시
**기존:** ASR/번역/임베딩/장면 처리에 별도 작업·모델 정보·리스가 존재; `scene_worker/stage.py`는 `SCENE_MAX_WINDOWS=120` 샘플링을 지원. 이 기존 결과 스키마를 삭제하지 않는다.
- 공통 `stage_checkpoint`에는 `jobId/assetId/fileVersion/modelFingerprint/pipelineVersion/stageName/completedUnits/totalUnits/artifactManifest/hash`를 저장.
- 각 작업의 완료 단위: ASR 오디오 청크, 번역 세그먼트 배치, 임베딩 텍스트 배치, 장면 분석 윈도 배치. 이미 완성된 결과도 모델 버전/원본 버전이 맞는 경우에만 재사용.
- **작업 중간 결과 쓰기 -> fsync 가능한 파일 마무리 -> 임시 매니페스트 -> DB checkpoint** 순서. 재시작 시 매니페스트와 DB를 조정; DB가 완료라고 하는데 결과가 없다면 해당 단위만 재실행.
- 최종 결과를 공개하는 API도 lease/asset/model 검증 후 승인을 받는다. 벡터·결과 표준화할 때 기존 결과 조회 경로의 호환성 유지.
- 진행률은 파일 크기/전체 토큰/오디오 길이/윈도 수를 기준으로 표현. 처리 실패한 일부 단위를 무시하고 전체 완료로 표시 금지.
- 장면 분석의 `SCENE_MAX_WINDOWS`가 적용되었다면 해당 영상 검색 색인의 **커버리지(샘플/전체, 분석 구간 수)**를 저장하고 설정 화면 또는 진단 정보에 표시. 자동 챕터 기능과 혼동하지 않는다.

### D-05. subprocess/FFmpeg timeout·하위 프로세스 수명 관리
**현재:** `apps/scene-worker/src/scene_worker/stage.py`의 `has_audio`, `cut_clip`, `write_thumbnail`은 `subprocess.run`에 timeout이 지정되지 않았다.
- 모든 외부 프로세스 호출을 공통 wrapper(`run_subprocess_checked`)로 통합. `timeout`, exit-code, 제한된 stderr, signal/cancel 전달, 작업 단위 식별자, parent PID/child PID 추적.
- Python에서 `subprocess.Popen(..., start_new_session=True)` 또는 플랫폼에 맞는 process group 실행 후 취소/timeout 시 그룹 TERM→grace→KILL; WSL/Linux 정상 동작 테스트. `subprocess.run(..., timeout=...)`만으로 별도 자식 프로세스까지 항상 정리된다고 가정하지 않음.
- Node/Bun FFmpeg 실행도 프로세스 그룹·abort와 `close` 완료를 조정. 결과 세대 게시 전 최신 fence 재확인. stdout/stderr 무한 누적으로 메모리 폭증 금지.
- 테스트: 손상/무한 대기 가상 파일, 강제 SIGKILL, ffmpeg child leak, VRAM lease 정리, 중간 결과 정리.

### D-06. ETA 예측 개선
- 기존 최근 완료 작업 중앙값 ETA는 대체 수단으로 유지. 정상 추정은 `remaining audio seconds / recent audio seconds per second`, `remaining segments or tokens / tokens per second`, `remaining scene windows / windows per second`, `remaining HLS frames / FPS` 등 작업 크기 기반.
- 모델 ID/revision, 장치, 인코더, 해상도별 최근 샘플을 그룹화. 샘플 부족 시 `basis='insufficient_data'`로 표시하고 거짓 숫자 대신 범위 또는 추정 없음.
- p50/p90 처리량을 메트릭으로 기록. 워커 시작 지연·GPU 대기·모델 로딩을 별도 측정. `estimatedFinishAt`과 `etaConfidence`는 근거가 있을 때만 DTO에 포함.

### D-07. 서버 진단: 모델/드라이버 사전 검사
- `GET /api/system/capabilities`에 NVIDIA 디바이스/VRAM 용량/지원 FFmpeg 인코더/필수 Python 모델 revision 및 SHA/각 워커 heartbeat/디스크 공간을 읽기 전용으로 보고.
- 모델 파일이 누락된 경우 설정 화면에서 명확히 알림, 배포 단계 `model-init`과 GPU worker dependency 확인. 실제 다운로드는 기존 모델 pin 정책 유지. 임의 최신 모델로 자동 교체 금지.

## E. Phase 2: 데이터베이스·검색·대용량 읽기

### E-01. 측정 우선 검색 최적화
**현재:** `packages/database/src/scenes.ts`는 SQLite에서 장면 벡터를 가져와 JS 내적 계산. `search.ts`에는 LIKE 기반 자막 검색. `assets.ts`의 `computeAssetRates`는 전체 대상에 대한 window rank.

**고정 단계:**
1. 기본 정확 검색을 성능과 정확도의 oracle로 보관.
2. 1천/1만/5만 자산, 장면 벡터 1만/10만/100만 건 등 재현 가능한 fixture와 벤치마크를 구성. 실제 시간·메모리·p95·정확도 기록.
3. 먼저 SQL/인덱스/쿼리 배치/벡터 데이터 메모리 캐시 및 `PRAGMA optimize`를 적용.
4. 전수 검색이 확정된 SLO를 지속적으로 초과할 때 FAISS HNSW 도입. 조건 예: 중형 fixture에서 warm p95 500ms 초과가 여러 번 재현되면 ANN branch 비교. **이 값은 목표 기준이지 기존 실측치가 아니다.**
5. ANN은 특정 장면 검색 후보만 생성하고 실제 DB 자산 상태와 모델 버전 검증 후 최종 순위를 확정.

**FAISS 구조:** `/cache/search-index/<index-generation>/visual.faiss`, `audio.faiss`, `av.faiss`, `mapping.sqlite`, `manifest.json`, `CURRENT`. 각 세대는 모델 SHA·차원·원본 DB watermark·생성 시간 저장. 생성 도중 전원 종료 시 마지막 유효 세대를 계속 사용; 세대 작성 완료 후 pointer 원자적 교체. 현재 DB는 재색인 가능한 source of truth. FAISS 부재/오류 시 기존 정확 검색 폴백.

**품질 기준:** 기존 full-scan 결과와 `Recall@10/@50`, 지연 p50/p95, 메모리 용량, 삭제 반영 지연 및 reindex 시간을 비교. 모델이 바뀌면 혼합 검색 금지; 분리 세대 재생성.

### E-02. SQLite FTS5 trigram과 한국어 짧은 검색 보호
- 파일명/ASR 세그먼트의 현재 LIKE 검색을 기본 호환 기준으로 보존. 3글자 이상 일반 부분 문자열 검색은 FTS5 trigram 후보를 받아 최종 LIKE/일치 조건으로 검증; 1~2글자 한국어 및 trigram이 적합하지 않은 검색어는 그대로 LIKE.
- `transcript_segments` 등의 DB 변경과 FTS 인덱스 동기화는 트리거 또는 단일 저장 함수에서 처리; 직접 수정 우회 금지. 각 migration 후 backfill/rebuild 가능.
- Bun Docker/Linux와 macOS의 SQLite 빌드 차이가 있으므로 배포 전 `PRAGMA compile_options`와 실제 `CREATE VIRTUAL TABLE` 테스트. FTS5 확장을 필수로 강제하지 않고 런타임 미지원 시 LIKE 폴백.
- 사용자 검색어를 FTS 구문으로 직접 연결하지 않는다; 특수문자 이스케이프/문자 길이 제한/쿼리 비용 제한.

### E-03. 정렬·페이지네이션과 Rate
- 현재 최신순은 keyset cursor, 다른 정렬은 OFFSET. `views/watch_time/votes/name/rate`도 `sortValue + id`의 seek cursor를 적용하되 NULL/동점/ASC·DESC 정렬을 정확히 처리.
- 값이 바뀌는 정렬의 일관성을 위해 pagination session을 만들거나, 첫 조회 시 정렬 snapshot version을 키에 포함. cursor에는 필터 해시·sort·방향·정렬값·기준 버전을 넣고 서버 비밀키로 서명/검증. 다른 필터에 cursor 재사용 거부.
- `rate` 전체 rank window 계산은 스냅샷 또는 저빈도 materialization으로 비용을 줄이며 기존 점수 규칙/기존 정렬 결과 변경을 별도 feature flag로 관리. 새로운 `completionRate`, `popularityScore`는 다른 필드/정렬로 도입, 기존 `rate` 재해석 금지.
- `EXPLAIN QUERY PLAN`으로 인덱스 사용/정렬 임시 테이블 여부 검증. `PRAGMA optimize`는 저부하 운영 작업에서 실행.

### E-04. 목록 조회의 부작용 제거
**현재:** `apps/api/src/routes/assets.ts`에서 목록에 포함된 동영상의 포스터 파일 존재 여부를 순차 조회하고 없으면 즉시 thumbnail job enqueue.
- `asset_derivatives` 또는 별도 cache manifest에 `pending/ready/failed` 및 `(asset_id,file_version,poster_version,size)` 저장. 목록 API는 DB 상태만 읽음. 별도 보이는 타일용 thumbnail 요청/실제 worker가 우선순위 갱신.
- 이미 생성된 실제 파일이 있으나 DB 상태가 유실될 경우 background reconciler가 발견. 자산 파일 버전/캐시 경로가 달라지면 구 derivative stale 처리.
- 과거 포스터 API 경로 호환; 캐시 header는 불변 파일에만 `immutable`, 오류/준비 상태에는 `no-store`.

### E-05. 통계와 캐시 계산
- `apps/api/src/routes/system.ts`의 스토리지 recursive walk를 API 요청에서 반복 수행하지 않고 백그라운드 작업에 위임. 결과는 마지막 계산시각·계산 범위·오류 여부와 함께 반환.
- 30초 TTL/강제 새로고침은 이전 결과를 보여주면서 새 작업을 시작. 동일 시점 갱신 요청은 하나만 처리(singleflight). 드라이브 미연결 시 전체 크기가 0인 것으로 덮어쓰지 말고 마지막 정상 수치+OFFLINE 마크.
- 재생 통계 등 빈번한 UPDATE로 정렬 캐시가 불필요하게 무효화되지 않도록 관련 필드 변경만 invalidate.

### E-06. 대용량 갤러리 데이터 윈도우
- `AssetGallery.tsx`의 JustifiedGrid 가상화는 유지. React Query `useInfiniteQuery(maxPages=...)`는 앞뒤 양방향 페이지 네비게이션과 함께 설정. 보이는 페이지와 주변 페이지가 없을 때 서버 커서로 다시 가져올 수 있어야 함.
- 필터 전환 시 stale query/key 재사용과 잘못된 scroll restoration 방지. 이미지 디코딩/hover preview/썸네일 동시 요청 수 한도 설정.
- 실제 브라우저 메모리/스크롤 FPS를 파일 수 규모별로 측정하고 결과를 `docs/BENCHMARKS.md`에 기록. 순수 '속도 개선' 주장 대신 Before/After 숫자 제공.


## F. Phase 3: 파일 관리·스마트 컬렉션·사용자 기능

### F-01. 정확 중복 파일 탐지
**제품 정책:** 정확히 같은 바이트의 파일 후보는 강하게 판별하지만 **자동 삭제하지 않는다**. 서로 다른 편집본, 해상도, 리인코딩본은 '유사 후보'로 별도 표시하고 오탐 가능성 표시.

**파이프라인:**
1. 같은 용량의 파일끼리 묶기(단독 크기는 해시 계산 생략 가능).
2. 파일의 고정된 앞/중간/끝 chunk의 빠른 fingerprint로 후보 축소. 크기와 부분 해시 같다고 중복 확정하지 않음.
3. full hash(SHA-256 또는 BLAKE3) 계산 후 **동일 바이트 확인**. 해시·파일 크기·fileVersion를 기록하고 해시 동안 원본 변경 여부를 시작/종료 메타데이터로 검증. 민감한 중복 그룹의 삭제 직전에도 재검증.
4. 동일한 hash/size를 `duplicate_groups`로 묶고 두 파일의 드라이브·경로·크기·해상도·추가 시각을 UI 표시. 각 파일은 원본 자산 ID 보존.
5. 필요 시 이미지 pHash나 영상 대표 프레임 fingerprint를 별도 후속 분석으로 구현; **이미지로 장면 검색 기능은 구현하지 않는다**. 유사 그룹은 자동 정리 금지.

**스키마:** `file_fingerprints(asset_id,file_version,size_bytes,quick_hash,full_hash,algo,calculated_at, PRIMARY KEY(asset_id,file_version))`, `duplicate_groups(id,kind,fingerprint,state,created_at)`, `duplicate_group_members(group_id,asset_id,confidence,PRIMARY KEY(group_id,asset_id))`. 중복 그룹은 매번 완전 재계산하지 않도록 incremental update.

**API:** `POST /api/duplicates/scans`, `GET /api/duplicates/groups?kind=exact|similar`, `GET /api/duplicates/groups/:id`, `POST /api/duplicates/groups/:id/decisions`(모든 파괴적 결정은 B-01 file mutation을 거침).
**UI:** 라이브러리 > 중복 검토, 비슷한 사진/영상 비교, 원본 경로 보기, 선택 유지, 삭제 미리보기, 복구 불가능 안내, 작업 결과 보고. 하드링크와 동일 파일을 여러 경로에서 참조하는 경우를 특별 취급.
**테스트:** 서로 다른 이름·경로/동일 내용, 같은 크기 다른 내용, 스캔 중 파일 변경, 0바이트, 대형 파일, 각 드라이브 단절, symlink/하드링크, 반복 해시 취소/재개.

### F-02. 스마트 앨범 (저장된 필터)
- 데이터 복사/폴더 이동 없이 기존 갤러리 필터 조합만 저장. 기본 조건 후보: kind, library, folder, tags ANY/ALL/NONE, 파일명, 해상도, 길이, 크기, taken_at, indexed_at, 조회수, 누적 재생시간, Vote, Rate, 최근 재생, AI 처리 상태, 중복 후보, 드라이브 상태.
- `FilterNode`를 `and/or/not` + 제한된 `field/operator/value`로 구성. JSON의 `filter_version=1`; 서버에서 Zod 검증 후 허용된 SQL 조각만 빌드. 원시 SQL/임의 JavaScript 전달 금지. 조건 수·중첩 깊이·결과 제한값 상한.
- `smart_albums(id,user_id,name,description,filter_version,filter_json,sort,created_at,updated_at)`; 즐겨찾기/핀 고정 선택값을 추가할 수 있음. 앨범 목록의 자산 수는 비동기 계산 후 TTL 캐시.
- **API:** `GET/POST /api/smart-albums`, `GET/PATCH/DELETE /api/smart-albums/:id`, `GET /api/smart-albums/:id/assets`(기존 listAssets를 공통 필터 빌더로 공유).
- **UI:** 좌측 `스마트 앨범`, 새 검색 조건 저장/이름 변경/고정, 앨범으로 이동, 조건 편집 및 검증 오류. 사용자 지정 태그와 혼동하지 않도록 실제 파일은 이동하지 않는다는 안내.
- 테스트: 0건/많은 건, 조합 AND/OR/NOT, 한글 검색어, 필터 변경 즉시 목록 갱신, 존재하지 않는 태그, 사용자 격리.

### F-03. 일괄 작업과 Dry Run
- 다중 선택 대상은 `explicit asset_ids` 또는 **필터 스냅샷** 중 하나로 저장. '현재 필터의 모든 결과'는 실행 직전 화면과 서버 건수를 대조하고 snapshot generation을 기록해야 실제 처리 대상이 도중에 바뀌지 않음.
- 작업 종류: 태그 부착/제거, AI 분석 재실행(기존 기능), 포스터 재생성, 파일 복사/이동, 파일 영구 삭제(항상 별도 확인), 선택 결과 내보내기. 대량 Vote는 의도적으로 무한 중복 이벤트를 만들 위험이 있으므로 기본 일괄 메뉴에서 제외.
- API `POST /api/bulk-operations/preview` (매칭 수/예상 총 용량/실제 원본 경로 목록 요약/권한 문제/드라이브 상태), `POST /api/bulk-operations`(고유 requestId), `GET /api/bulk-operations/:id`, `POST /api/bulk-operations/:id/cancel|retry`.
- `bulk_operations`(부모), `bulk_operation_items`(개별 자산의 결과)로 분리. 10,000건 한 트랜잭션/단일 프로세스로 묶지 않고 chunk 단위 커밋. 각 자산 변경은 별도 멱등 키로 중복 반영 방지.
- 삭제·이동은 B-01 mutation 엔진 공유; 일괄 작업 취소는 **아직 확정되지 않은 대상**만 취소. 이미 영구 삭제한 파일을 되돌린다고 표시하지 않음.
- UI는 전체/성공/실패/보류/취소 숫자, 오류별 그룹, 특정 파일만 재시도 제공.

### F-04. 파일 이동·재연결 시 자산 정체성 보존
- **의도한 사용자 이동**은 동일 파일로 검증할 수 있으면 `asset_id`를 유지하고 경로·라이브러리·폴더만 조정. Vote·조회수·시청 시간·태그·리뷰·AI 결과를 보존. 파일 내용/버전이 변경되면 파생물은 무효화.
- 같은 파일시스템 이동: rename → DB 조건부 업데이트 → reconcile. 서로 다른 파일시스템 이동: copy temp → 파일 크기/전체 해시 verify → 새 위치 가시화/DB 변경 → 원본 격리/삭제. 각 단계 중단 재개/재시도 가능.
- `UNIQUE(library_id, relative_path)` 충돌, 기존 soft-deleted 행과 재등장, 새 폴더 생성/카운트, folder pinned cover, 관련 vote events·기여 로그 경로 일관성은 migration/DB 로직에서 명시적으로 처리.
- 사용자 동작이 아닌 외부 탐색기 이동은 파일 해시·식별자 신뢰 범위가 충분할 때만 자동 재연결 제안. 불분명하면 두 자산을 임의 병합하지 않고 사용자 승인 요청.

### F-05. 시점 북마크와 재생목록
**새 기능:** 영상 타임스탬프 북마크(예 `00:15:20` + 메모), 사용자 정의 재생목록, 나중에 보기. 모두 사용자가 선택하는 일반 목록 기능이며 AI 자동 챕터 생성과 다름.
- `video_bookmarks(id,user_id,asset_id,position_ms,title,note,created_at,updated_at)`, `playlists(id,user_id,name,description,created_at,updated_at)`, `playlist_items(playlist_id,asset_id,position,added_at,PRIMARY KEY(playlist_id,asset_id))` 또는 같은 영상을 여러 번 넣을 수 있는 item PK. '나중에 보기'는 사용자별 기본 목록 한 개로 구현.
- API `GET/POST /api/assets/:id/bookmarks`, `PATCH/DELETE /api/bookmarks/:id`, `GET/POST/PATCH/DELETE /api/playlists`, `POST/DELETE/PATCH /api/playlists/:id/items`.
- UI: 플레이어의 북마크 버튼, 현재 시각 저장, 메모 열기, 좌측 재생목록, 드래그 정렬, 삭제된 자산 항목은 깨진 링크 안내 후 정리.

### F-06. 기존 포스터 캡처 기능의 품질 보강
**현재 이미 구현:** `POST /api/assets/:id/thumbnail`은 `extractCustomVideoPoster()`와 `bumpPosterVersion()`을 호출한다. 신규로 중복 구현 금지.
- 타임라인에서 포스터 선택 UI 개선, 캡처 작업 진행 상태, 파일 버전·리스 확인 후 게시, 실패 시 이전 포스터 유지, 브라우저 query version과 CDN/cache version 갱신.
- 이미지/폴더 포스터 고정 기능은 기존 `folders.pinned_cover_asset_id`를 재활용. 별도 기능 생성으로 DB 충돌을 만들지 않음.

### F-07. 파일 상세 메타데이터와 UX 보강
- 파일 정보 패널: 원본 경로(권한 내), 코덱/프로파일/비트레이트/프레임레이트/비트 깊이/HDR/오디오 트랙/해상도/길이/추가 날짜/AI 처리 상태. `ffprobe` 실행 결과 캐시.
- `Cmd/Ctrl+K` 명령 팔레트, 사용자 지정 키보드 단축키, 터치 제스처/키보드 접근성, aria-label/포커스 관리, 오류 Toast/진단 링크.
- 테마는 기존 Light/Dark/System 및 CSS 토큰 유지. 전체 레이아웃 리라이트 지양; 사이드바에 `중복 검토`, `스마트 앨범`, `재생목록`만 정보구조에 맞춰 추가. 검색/관리 결과 긴 목록에도 스크롤과 focus 유지.
- PWA: 앱 셸과 정적 리소스만 기본 캐시. 개인 원본/인증된 영상·썸네일/개인 API 응답을 기본 오프라인 캐시에 영구 저장하지 않음. 로그아웃 시 캐시 무효화, 오프라인 저장은 별도 명시적 opt-in으로만 추후 구현.

### F-08. RAR 보안·처리·비밀번호
**현재:** `packages/media/src/archive.ts`에 하드코딩된 `ARCHIVE_PASSWORDS=['','misskon.com','mrcong.com']`; `archive_jobs.password_used`에 성공한 비밀번호를 기록할 수 있음. 이미 경로 순회/임시 처리의 일부 방어가 있으므로 유지.
- 비밀번호 후보는 관리자 설정 또는 별도 secret 파일로 공급하고, 웹 설정에는 마스킹. 비밀번호 성공 여부는 참/거짓 또는 `password_source_id`만 기록. **새 작업부터 `password_used` 평문 영구 기록 중단**; 기존 DB 필드의 평문 보존 여부는 백업 정책을 고려하여 관리자에게 안전 정리 절차 제공.
- 압축 해제 시 최대 파일 수/최대 전체 해제 바이트/임시 사용량/압축률 경고/경과 시간·취소/압축 다중 볼륨 안정화 검사. 예상치만 믿지 말고 실제 쓰기량도 감시.
- 압축 해제 작업은 원본 rw가 필요한 mutation worker로 이전. 다른 워커에선 read only. 미완료 압축 해제는 내구성 있는 manifest를 통해 정리 또는 재시도.
- 악성 symlink·절대 경로·Windows 특수 파일명·심볼릭 경로/경로 재사용·RAR 비밀번호 오류 테스트, 복구 가능한 중단 시 기존 압축 원본은 항상 보존.

## G. Phase 1~3: 인증·서비스 보안

### G-01. 비밀번호 해시 점진적 Argon2id 전환
**현재:** `apps/api/src/auth.ts`는 `scrypt$N$r$p$salt$key`, 기본 `N=16384,r=8,p=1`을 사용. 기존 해시를 일괄 폐기하면 안 됨.
- 신규 사용자 또는 재해시부터 Bun 내장 `Bun.password.hash(..., {algorithm:'argon2id', memoryCost:..., timeCost:...})` 사용. 매개변수는 OWASP 권고를 초기 기준으로 잡되 실제 운영 CPU/메모리/로그인 지연을 벤치마크한 뒤 확정. 예: memory 19MiB 이상, timeCost 2 이상, parallelism 1 이상을 OWASP 자료와 현재 Bun 런타임에 맞춰 검증. 버전이 다른 PHC 해시도 지원.
- 로그인 시 구 scrypt로 정상 검증 성공 → Argon2id로 재해시 → `users.password_hash` 갱신. 구 해시의 유효성 검사 과정에서 비정상적인 매우 큰 N/r/p가 입력되는 경우 DoS를 막기 위한 한도 검증.
- 존재하지 않는 사용자도 해시 비용을 동등하게 수행하지만 공격자가 많은 병렬 요청으로 CPU를 소진하지 못하게 로그인 Rate Limit과 동시 처리 제한을 적용.

### G-02. 서버 측 세션 관리 및 토큰 폐기
**현재:** HMAC 서명된 사용자 ID+만료시간 토큰을 30일 쿠키로 저장. 로그아웃 시 브라우저 쿠키만 삭제하므로 유효한 복제 토큰 개별 폐기 불가.
- 세션 ID(random 256-bit)을 HttpOnly/SameSite=Strict/Secure(HTTPS) 쿠키에 넣고, DB에는 토큰의 HMAC/SHA-256 digest(평문 세션 토큰 저장 금지), 사용자 ID, 발급·마지막활동·만료·폐기시간·User-Agent 요약을 기록. 로그인 후 서버 lookup → 활동 기록 throttle.
- `POST /api/auth/logout`에서 해당 세션 폐기; `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`, `POST /api/auth/logout-all` 제공. 관리자 계정 비밀번호 변경 시 세션 전부 폐기.
- 기존 HMAC 토큰은 이전 브라우저가 갑자기 로그아웃되지 않도록 **최대 30일 전환 기간의 읽기 호환 또는 로그인 시 새 세션 쿠키 발급**을 수행하고, 구 토큰 수락 종료 시점 명확히 설정. 보안 사고 시 운영자가 강제 전체 폐기할 수 있어야 함.
- `parseCookies`의 `decodeURIComponent` 예외를 catch하여 malformed 쿠키는 401로 처리. 쿠키 최대 길이 및 정규화 검사.

### G-03. 로그인·최초 관리자 등록 보호
- DB 최초 계정 등록은 `countUsers()>0` 확인과 `INSERT`를 같은 `BEGIN IMMEDIATE` 트랜잭션으로 묶고, 최초 계정 1개 정책 강제; 동시 `/setup` 요청이 두 계정을 만들 수 없게 테스트.
- 로그인 실패 횟수 제한(IP/사용자 이름), 지연/쿨다운, 실패 응답 메시지 통일, 감사 로그. VPN/프록시 IP 위장으로 제한 우회 가능성을 막도록 `trustProxy` 신뢰 목록을 제한.
- Fastify `trustProxy:true` 대신 Nginx 한 홉/내부망 소스만 신뢰하도록 `app.ts` 설정, 외부에서 API 컨테이너 직접 접근 불가 보장. 보안 헤더, CSRF/Origin 검증(쿠키 인증 상태 변경 요청의 출처 제한), CORS 기본 비활성 유지.
- `.env` 기본 인증 비밀이 빈 값일 때 운영 시작 실패, 개발 모드만 명시적인 예외. `COOKIE_SECURE`는 HTTPS 구성과 반드시 일치; LAN HTTP 사용과 외부 공개를 분리. 외부 인터넷 공개는 HTTPS+인증+방화벽/터널 구성이 완료될 때만 지원.

### G-04. 미디어 경로와 파일 접근 검사
- API 파일 경로는 항상 서버 측 `library_id/asset_id`에서 해석하고 클라이언트 제공 절대경로를 임의 읽거나 쓰지 못하게 한다. 현재 `resolveInside` 경계 검사 유지 및 실제 filesystem `realpath/lstat` 검사 보강.
- 특히 삭제/이동/압축 해제는 symlink·reparse·바뀐 파일 inode에 대한 검사 후 재확인. `fs.stat`/`realpath` 검사 뒤 실제 unlink 간 TOCTOU를 JavaScript 문자열 검사만으로 완전히 제거했다고 주장하지 않는다. 위험 작업은 제한된 root·명시적인 symlink 거부 정책 및 작업 시점 재검증으로 공격 표면 최소화.
- Nginx `/internal/*`은 계속 `internal`로 두고 인증된 API의 X-Accel-Redirect만 파일에 접근하도록 유지. HLS 세대별 URL도 같은 정책.

### G-05. Compose·의존성·공급망
- `.env.*` build context 제외; 비밀값은 가능한 경우 Compose secret 파일로 컨테이너에 공급. 토큰별 최소 권한 및 rotation 문서.
- base image/런타임/FFmpeg/AI 모델 revision을 manifest에 명시, Python `uv.lock`/requirements lock 및 Bun `bun.lock` 존중. 안정 버전 pin과 주기적 보안 업데이트 분리.
- SCA(의존성 취약점), 컨테이너 이미지 검사, 이미지 checksum/digest 검증을 CI에서 수행. 새 패키지 추가는 중복 기능·유지보수 상태 검토 후 최소화.


## H. Phase 4: 운영 관측성·백업·자동 관리

### H-01. 상태 표시를 프로세스/데이터/작업으로 분리
**현재:** `/health/live`, `/health/ready`, `/api/system/status`, 60초 integrity 캐시, `recovery_logs`, `backup_logs`, `library health` DTO 및 `ProcessingPanel`이 이미 있다. 새 헬스체크를 중복 구현하지 않는다.
- **Liveness:** 요청에 응답하는가? DB 전체 검사/원본 마운트 접근을 넣지 않는다.
- **Readiness:** DB 및 필수 로컬 데이터 경로에 접근 가능한가? 외부 드라이브 일시 OFFLINE 때문에 무조건 전체 서비스 재시작 금지.
- **Library health:** 저장소별 ONLINE/DEGRADED/OFFLINE/UNVERIFIED, 마지막 정상 스캔/현재 읽기 오류/누락 보류 수.
- **Worker health:** 마지막 heartbeat, 실행 중 작업·경과 시간, GPU lease/모델 준비, 최근 연속 실패/중단 사유.
- **Backup health:** 마지막 정상 DB 백업, 외부 사본 유무, 마지막 복원 리허설, 보존 용량 및 정책.
- **Storage health:** 원본/캐시/AI 결과/백업/임시·격리 영역별 용량과 추세. 전체 용량 계산 실패를 `0`으로 보여주지 않고 `stale=true` 표시.

### H-02. 운영 메트릭과 요청-작업 연결
- 메트릭: API request p50/p95/error rate, SQLite query latency/WAL bytes/DB busy, scan files/s/read errors, 작업 queue length/lease loss/retry, GPU lease wait/OOM, HLS first-ready time/cache hit/FFmpeg speed, 백업 성공·복원 검증, 파일 수정 작업 실패.
- 모든 API 요청에 `request_id`; enqueue에서 `operation_id/job_id`; 워커 프로세스에 `worker_id/lease_epoch`; 결과에는 `asset_id/file_version/generation_id` 전달. 사용자 화면 오류에는 짧은 diagnostic ID.
- 로그 본문에 token, Cookie, RAR password, 비밀 env, 전체 원본 경로 노출 금지. Prometheus 메트릭에 assetId/jobId 같은 고유 값들을 라벨로 사용하지 않음(카디널리티 폭발 방지).
- 단일 PC 기본은 구조화 JSON 로그와 자체 SQLite 집계 API. Prometheus/OpenTelemetry exporter는 optional `compose.monitoring.yaml`; Grafana·Loki 전면 강제 설치 안 함.

### H-03. 경고·알림과 재난 자동 복구
- 알림 유형: 드라이브 OFFLINE, 검증되지 않은 대량 누락, 디스크 부족, GPU OOM 반복, 작업 stalled, 백업·복원 실패, SQLite 무결성 이상, 서비스 재시작 루프, 중요한 파일 변경 실패.
- 채널: 앱 내 알림함(기본), Discord Webhook(선택). webhook URL은 secret로 저장·로그 마스킹, 실패 시 제한된 재시도. 하나의 장애가 매 15초마다 알림을 발송하지 않도록 `dedupe_key + cooldown + recovery notice`.
- 리컨실러는 `missing cache regeneration`, `expired lease requeue`, `stale temp cleanup`, `incomplete HLS generation cleanup`, `incomplete file mutation reconciliation`, `unfinished backup`을 처리. 원본 불명/격리 상태는 **자동 파괴 금지**. 각 복구에 이벤트 로그와 `recovered/blocked/needs_operator` 결과 저장.
- 알림 정책 기본값: 드라이브 OFFLINE은 즉시 1회; 작업 실패 연속 N회; 백업 미실행 48시간; 디스크 여유 10% 미만 또는 작업 예상 용량 미달; 변경 가능. 이 숫자들은 초기 제안 설정이며 실제 운영 볼륨을 측정해 조정.

### H-04. 캐시 관리와 디스크 부족 대응
- 캐시 종류: thumbs, previews, HLS generations, remux(optional), AI temp, scene thumbnails, 검색 인덱스, 모델 캐시(모델은 자동 LRU 삭제 금지), file mutation quarantine(자동 임의 삭제 금지).
- 각 캐시 manifest에 최종 사용 시각·assetVersion·크기·재생성 가능 여부 기록. 삭제 우선순위는 오래된 **재생성 가능한** HLS/preview/temp 순; 원본·DB·활성 checkpoint·격리 원본은 캐시 GC 대상에서 제외.
- 예약 작업 시작 전 필요 공간 예측이 가능하면 확인. 디스크 부족이면 쓰기 많은 작업/아카이브 해제/인코딩을 대기 상태로 전환. 최소 여유 공간은 볼륨별 정책.
- 사용자 설정 화면에서 전체 캐시 용량, 타입별 용량, 안전 정리 미리보기, 정리 대상 크기, 정리 후 복원 비용 표시.

### H-05. 자동 부팅·SSH·WSL2 안정성
**현재:** Windows PowerShell 감독 스크립트에 전역 Mutex, WSL keepalive, docker/ssh systemd 확인, DrvFS 준비 검사, compose up, LAN portproxy 갱신, health watchdog, 로그 회전이 이미 있다.
- Windows 부팅 → WSL 활성화 → Docker/SSH systemd 상태 → 실제 필수 드라이브 마운트 → Compose `config -q`와 preflight → 최종 `up -d` 순서. 필수 드라이브 미연결이면 해당 볼륨의 원본 관리 작업은 미실행하고 OFFLINE 안내; Docker가 빈 폴더를 대체 생성하지 못하도록 함.
- 기존 compose 조합을 PowerShell `_common.ps1`에서 한 곳만 관리하고 사용자가 선택한 AI Compose overlay와 작업 실행용 환경파일을 일관되게 적용. `.env.*` 새 파일 추가 시 읽기 정책도 갱신.
- 고정 `192.168.*` 네트워크 탐지는 LAN·Tailscale·다른 사설망 환경에서 실패할 수 있어 선택 가능한 인터페이스/IPv4 목록으로 변경. portproxy 갱신은 중복 규칙/방화벽과 충돌하지 않게, 외부 인터넷 공개 금지 기본값 유지.
- SSH는 키 기반 접속·서비스 자동 시작·설정 변경 백업·방화벽 최소 허용·기존 포트 매핑 유지. Windows 재부팅/로그오프/WSL 재시작/인터넷 단절 후 재연결을 E2E로 확인.
- supervisor는 매 15초 readiness 실패 시 무조건 모든 컨테이너 재시작하지 않도록 **원인별 재시작**(API crash vs 드라이브 OFFLINE vs GPU model failure). 동일 실패에 과도한 restart-backoff 적용하고 마지막 오류 저장.
- 서버의 실제 전원 상실 후 자동 켜짐은 BIOS 설정 및 Windows 권한이 필요하므로 수동 실기기 검증 항목으로 유지.

### H-06. 진단 보고서와 운영자 Runbook
- `GET /api/system/diagnostics`는 관리자에게만 제한. DB version/WAL/health, driver/FFmpeg capability, 라이브러리 상태, 워커 heartbeat, model manifest, 백업 검증, cache usage, compose 환경 검사 결과 반환. 민감정보 가려서 `.json` 또는 `.md` 다운로드.
- `docs/OPERATIONS.md`, `docs/INCIDENT-PLAYBOOK.md`, `docs/BACKUP-RESTORE.md` 작성: 드라이브 제거, DB 잠김, GPU OOM, FFmpeg stuck, snapshot restore, file mutation blocked, 인증 토큰 교체, 모델 mismatch 등의 대응 절차.
- `docs/ARCHITECTURE.md`는 현재 제목이 schema v14라고 되어 있으므로 migration v15 및 신규 최종 스키마/작업 정책과 동기화. 코드는 실제 `SCHEMA_VERSION = 15`이므로 문서에 잘못된 버전 표기 유지 금지.

## I. 마이그레이션과 API 계약: v15에서 안전하게 진화

### I-01. Migration 계획 (모두 순차적·가산적)
**고정 원칙:** 기존 `MIGRATIONS` 배열 1~15를 수정/재정렬하지 않는다. `SCHEMA_VERSION`만 각 PR에서 하나씩 증가시키고, 테이블 생성/컬럼 추가 시 기존 데이터 기본값/NULL 호환성을 지정한다. 파괴적 컬럼 제거는 맨 마지막 deprecation 릴리스 이후에만 수행.

| 다음 버전(제안 순서) | 내용 | 핵심 신규 테이블/컬럼 |
|---|---|---|
| v16 | 파일 안전성·라이브러리 건강 | `file_mutations`, `mutation_events`, `library_health`, `scan_runs` 확장 |
| v17 | HLS 및 파생물 게시 | `hls_generations`, `hls_active`, `asset_derivatives` |
| v18 | 인증 | `user_sessions`, `auth_login_attempts`, 감사 로그 테이블 |
| v19 | 재생 멱등성 | `play_sessions`, `play_events`, `playback_progress` 최신 이벤트 버전 |
| v20 | 작업진단·복구 | `worker_health`, `operation_failures` 또는 기존 작업 테이블의 errorCode/메트릭 확장 |
| v21 | 중복 파일 | `file_fingerprints`, `duplicate_groups`, `duplicate_group_members` |
| v22 | 스마트 앨범·재생목록·북마크 | `smart_albums`, `playlists`, `playlist_items`, `video_bookmarks` |
| v23 | 일괄 작업 | `bulk_operations`, `bulk_operation_items` |
| v24 | 운영 알림·진단 | `notifications`, `notification_delivery_attempts`, `diagnostics_runs`, 필요시 backup 검증 정보 |
| v25 | 검색 부가 정보 | `search_index_generations` 및 필요 시 FTS5 tables/triggers(런타임 지원 검사 후) |

*주의:* migration 번호는 실제 개발 브랜치의 순서에 따라 조정할 수 있으나 각 migration의 의미/순서는 릴리스 문서와 정확히 일치해야 함. 위 표는 본 명세에서 **실행 순서로 확정한 계획**이며 실제 DB 적용 완료를 뜻하지 않음.

### I-02. Migration runner 및 백업 보호
- 현재 `openDatabase()`는 시작 시 자동 migrate를 실행한다. 새 릴리스에서는 앱과 워커가 동시에 무거운 migration을 시작하지 않도록 운영 배포를 `upgrade preflight -> pre-migration backup -> 단일 migrator -> verify -> api/worker start`로 분리.
- 테스트/개발에서는 현재 `openDatabase` 사용성을 유지하도록 `migrateOnOpen` 옵션을 지원할 수 있으나 운영에서는 migrator 1개만 schema write 권한을 갖도록 한다.
- migrator는 DB 스키마가 현재 코드보다 **높으면 즉시 시작 거부**하고 낮으면 승인된 버전만 올린다. backup 검증 실패/디스크 부족 시 migration 실행 금지. 실패한 migration은 SQLite 트랜잭션에 따라 롤백하고 현재 DB를 보존.
- 되돌리는 migration을 애드혹으로 작성하지 말고, 필요한 경우 **업그레이드 직전 백업** 복원과 이전 실행 버전의 전체 정합성을 복구하는 runbook 마련. 업그레이드 후 원본 파일 변경이 있었다면 단순 DB 복구만으로 되돌릴 수 없음도 사용자에게 안내.

### I-03. API 계약 / 오류 형식
**공통 응답 (실패):** `{error: stableCode, message: localizedMessage, requestId, details?:{...}}` (민감 경로·비밀값 제외). 예: `source_offline`, `file_version_conflict`, `operation_blocked`, `lease_lost`, `unsupported_media`, `insufficient_storage`, `not_ready`, `invalid_cursor`.
- 모든 새 `POST` 작업 생성 API는 idempotency key 지원; 무거운 비동기 작업은 `202 {operationId,state,statusUrl}`. 읽기 전용 조회는 `GET`, 수정/일괄 작업은 `POST/PATCH/DELETE` 의미 지킴.
- 기존 API는 충분한 전환 기간에 병행 운영. 프런트와 API 동시 배포 시 feature flags/capabilities로 새 응답 지원 여부 확인. 예전 클라이언트가 무한 polling을 하지 않도록 202 상태와 표준 API를 매핑.
- 요청/응답 스키마는 shared TypeScript DTO + Zod로 중앙화. Python 워커에는 대응하는 Pydantic(또는 명시적인 JSON 검증) 모델. 허용하지 않은 필드/상태를 조용히 무시하지 말고 계약 버전 오류를 명확히 기록.

### I-04. 전체 추가 API 요약
| 영역 | 신규/변경 API | 설명 |
|---|---|---|
| 삭제·이동 | `POST /api/assets/:id/delete-operations`, `/api/file-operations/:id`, `/api/assets/:id/move-operations` | 원본 변경은 작업 큐·멱등화 |
| 드라이브 상태 | `GET /api/libraries/:id/health`, `POST /api/libraries/:id/verify` | 드라이브 존재/읽기/안전성 검증 |
| HLS | `GET /api/assets/:id/hls`, `/api/assets/:id/hls/g/:generation/:file` | 준비·세대별 재생 |
| 플레이어 | `POST /api/play-sessions`, `POST /api/play-sessions/:id/events` | 조회/시청 시간 중복 방지 |
| 탐색 | `GET /api/assets/:id/neighbor`, `POST /api/assets/random` | 전체 목록 순차·셔플 |
| 중복 검사 | `POST /api/duplicates/scans`, `GET /api/duplicates/groups` | 동일/유사 후보 |
| 스마트 앨범 | `/api/smart-albums`, `/api/smart-albums/:id/assets` | 저장된 필터 |
| 일괄 처리 | `/api/bulk-operations/preview`, `/api/bulk-operations`, `/api/bulk-operations/:id` | Dry Run/진행률 |
| 재생목록/북마크 | `/api/playlists`, `/api/assets/:id/bookmarks` | 사용자 목록과 시점 메모 |
| 인증 | `/api/auth/sessions`, `/api/auth/logout-all` | 개별 세션 폐기 |
| 운영 | `/api/system/capabilities`, `/api/system/diagnostics`, `/api/notifications` | 능력/진단/알림 |
| 백업 | `POST /api/backups`, `GET /api/backups/:id` | 비동기 생성·상태 |

### I-05. Feature flags (필수)
- `FILE_MUTATION_ENGINE_ENABLED`, `HLS_GENERATIONS_ENABLED`, `PLAY_EVENTS_ENABLED`, `SERVER_RANDOM_ENABLED`, `SMART_ALBUMS_ENABLED`, `BULK_OPERATIONS_ENABLED`, `SEARCH_FTS_ENABLED`, `SEARCH_FAISS_ENABLED`, `NOTIFICATIONS_ENABLED`.
- 초기에는 모두 off(단, 안전성 preflight 같은 수정은 항상 on). 테스트→개발→샘플 라이브러리→실서버 적용 순서로 순차 활성화. 기존 경로 제거는 새 경로의 호환·복원 테스트 이후.
- 사용자 설정에 버전·활성화 기능·필요한 워커가 누락된 경우의 degraded 상태를 표시. 위험한 삭제 기능을 feature flag OFF로 되돌릴 때 진행 중 작업 상태는 여전히 reconciler가 추적하도록 한다.


## J. 코드 구현 패턴(에이전트가 반드시 지켜야 하는 수준)

### J-01. 파일 삭제 의사코드
```ts
async function requestDelete(db, userId, assetId, requestKey) {
  return db.transaction(() => {
    const asset = requireLiveAsset(db, assetId);
    assertLibraryWritableAndOnline(db, asset.libraryId);
    const existing = findMutationByRequestKey(db, userId, requestKey);
    if (existing) return existing; // 동일 요청 재시도는 1회만
    return insertMutation(db, {
      kind: 'delete', assetId, libraryId: asset.libraryId,
      requestedFileVersion: asset.fileVersion,
      requestKey, state: 'requested',
    });
  }).immediate();
}

async function executeDeleteMutation(mutation, fence) {
  // 1. 리스/요청 버전/마운트 및 파일 실제 정체성 검증
  // 2. 검증된 동일 볼륨 격리 경로로 rename + 매니페스트 저장
  // 3. fence 검증 후 DB 상태를 quarantined -> db_committed로 전이
  // 4. 캐시·중간 결과의 재생성 가능 데이터 정리
  // 5. 사용자에게 '영구 처리 완료' 가능한 조건에서만 completed
  // 6. 실패하면 현재 상태를 보존해 reconciler가 재검토
}
```
**절대 피할 것:** `unlink()`를 수행한 다음 DB에서 아무 조건 없이 `DELETE FROM assets`를 실행하는 기존 흐름. URL만으로 사용자 인증이 생략되는 별도 워커 API. 격리 이후 검증 없이 임의 다른 경로를 삭제하는 코드.

### J-02. 결과물 Publish Guard 공통 인터페이스
```ts
interface PublishContext {
  assetId: string;
  fileVersion: number;
  jobId: number | string;
  workerId: string;
  leaseEpoch: number;
  modelFingerprint?: string;
  signal?: AbortSignal;
}

interface PublishGuard {
  canPublish(context: PublishContext): boolean;
}
```
동일 원칙을 thumbnail/preview/HLS/임베딩/ASR/번역/장면 인덱싱/포스터 커스텀 캡처에 맞게 적용. 파생 결과의 실제 게시 전에 **현재** 파일/작업 상태를 검사해야 하며, 최초 작업 시작 시 검사만으로 충분하지 않음.

### J-03. HLS immutable generation 예시
```text
/cache/hls/<assetId>/v<fileVersion>/
  g/<generationId>/master.m3u8
  g/<generationId>/seg00000.ts
  g/<generationId>/seg00001.ts
  ...
```
클라이언트는 특정 generation의 playlist URL을 받고 세그먼트도 동일 세대에서 로드. `active_generation_id`가 변경되더라도 이미 재생 중인 목록의 내용이 바뀌지 않는다. 완료 전 temporary path는 외부 API에서 참조하지 않는다.

### J-04. 핵심 DB DDL 초안 (세부 제약은 실제 FK와 타입에 맞춰 조정)
```sql
CREATE TABLE file_mutations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('delete','move','copy','extract')),
  asset_id TEXT,
  library_id TEXT,
  request_key TEXT NOT NULL UNIQUE,
  requested_file_version INTEGER,
  state TEXT NOT NULL,
  source_rel TEXT,
  quarantine_rel TEXT,
  lease_owner TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX idx_file_mutations_state ON file_mutations(state, updated_at);

CREATE TABLE play_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  file_version INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  view_recorded_at INTEGER,
  last_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE play_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES play_sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  delta_ms INTEGER,
  position_ms INTEGER,
  recorded_at INTEGER NOT NULL,
  UNIQUE(session_id, seq)
);

CREATE TABLE user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id, expires_at);
```
**운영 시 주의:** 위 SQL은 설계용 골격으로서 전체 migration 코드를 대신하지 않는다. 신규 table의 CHECK 상태, foreign key CASCADE 정책, `asset_id` delete와 감사 로그 보존 관계, idempotency key의 사용자별 namespace, SQLite trigger/indices는 각 단계에서 실제 DB 정책과 맞춰 구현해야 한다. 특히 삭제 감사 로그를 원본 `assets` FK CASCADE에 묶어 로그까지 지워지게 만들면 안 된다.

### J-05. 클라이언트 재생 집계 제약
- 동일 이벤트를 두 번 받았을 때 HTTP 응답의 asset 카운트는 같아야 함. `INSERT ... ON CONFLICT DO NOTHING` 성공 여부를 확인해 변경이 실제 발생한 경우에만 `assets.watch_time_ms += delta_ms`.
- 연속 `seq`가 일부 빠질 때는 서버가 도착한 유효 이벤트만 수용/다음 이벤트 대기 중 무엇을 할지 명확히 결정; 임의 순서 역전으로 진행률이 감소하지 않도록 필드별 다른 정책 적용.
- 이벤트를 무한 보관하기 어렵다면 일정 보존 기간이 지난 **완료된 세션의 단일 ID 범위 watermark**를 유지해 오래된 이벤트 재전송도 이중 계산되지 않도록 한다. 기록 단순 삭제로 멱등성이 깨지지 않아야 함.

## K. 검증·CI·장애 주입·성능 게이트

### K-01. 테스트를 먼저 작성할 모듈
| 영역 | 테스트 및 실패 시나리오 |
|---|---|
| Migrations | 빈 DB부터 v25, 실제 v15 백업에서 각 버전 순차 업그레이드, 실패 시 롤백, FK 검사, row counts |
| 삭제·이동 | 각 상태 직후 kill, 동일 requestKey 재전송, 라이브러리 OFFLINE, 파일 바뀜, symlink, 경로 충돌, 디스크 부족 |
| 스캔 | 작은 라이브러리 전체 사라짐, 루트 빈 디렉터리, permission denial, 체크포인트 중단·재개, 마운트 교체 |
| Compose | 필수 드라이브 없는 경로는 자동 생성 안 됨, optional/profile, ASR/Scene 원본 접근 |
| HLS | generation 교체 중 재생, 오래된 워커 게시 거부, FFmpeg 실패·aborted, GC grace period |
| Playback | 한 이벤트 100회 재전송도 카운트 1회, HTTP 성공 후 응답 유실, 두 탭, seek·pause·pagehide |
| Viewer | A 조회 중 B 열기, close 후 A 늦은 응답, 빠른 next 2회, shuffle/필터 바꾸기 |
| Job Engine | lease 만료 후 재점유, old epoch 게시 거부, GPU OOM, 하위 프로세스 timeout, 장면 큐 통계 |
| Search | 짧은 한글, trigram/LIKE 결과 일치, FAISS stale/모델 변경/원본 삭제/정확 검색 폴백 |
| Duplicate | 같고 다른 바이트, 검출 중 원본 변경, hash 중 종료, hash 알고리즘 변경, 대형 스트리밍 |
| Albums/Bulk | 잘못된 JSON AST, 10,000건 선택 대상 스냅샷, cancel/retry, 파일별 오류, 멱등성 |
| Auth | malformed cookie, legacy scrypt, Argon2id 점진 전환, session revoke, 동시 setup, Rate Limit |
| Archive | Zip-bomb/RAR 폭탄, 비밀번호 실패, 악성 경로, 추출 중단, 원본 보존 |
| Backup | 백업 중 종료, 복원 리허설, 손상된 backup 파일, schema 변경 후 restore, 동시 DB 연결 차단 |
| Windows | 부팅·로그오프·WSL 다운·LAN IP 변경·드라이브 분리·포트프록시 복원 |

### K-02. 자동화 테스트 명령(실제 코드가 추가돼야 함)
```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run --cwd apps/web build

# 각 Python 워커 개별 실행 (동일 이름의 테스트 모듈 충돌 회피)
(cd apps/asr-worker && uv run pytest)
(cd apps/translation-worker && uv run pytest)
(cd apps/embedding-worker && uv run pytest)
(cd apps/scene-worker && uv run pytest)

docker compose --env-file .env -f compose.yaml config -q
# 실제 테스트용 별도 데이터볼륨/fixture에서만 integration/e2e/fault 테스트
```
*현재 컨테이너에서 위 전체 테스트를 새로 실행한 결과는 아님. 실제 WSL2/RTX GPU/Docker 환경에서 따로 실행해야 함.*

### K-03. E2E 사용자 시나리오
1. 기존 DB v15 백업과 샘플 원본 복제, 로그인, 기존 태그·Vote·리뷰·시청시간 확인.
2. 이미지·동영상 목록 > 검색 > 정렬 > 마지막 페이지 > 뷰어 next/prev > shuffle.
3. Direct Play / HLS 변환 / 새 탭 전환 / 이어보기 / 자막 표시 / 재생 중 source offline.
4. 포스터 직접 선택, 폴더 고정 커버, thumbnail cache version 갱신.
5. 새 중복 검토/스마트 앨범/일괄 작업 Dry Run/파일 이동/북마크/재생목록.
6. WSL2 서비스 종료·재시작, 드라이브 remove/reconnect, GPU 워커 SIGKILL, HLS 부분 캐시.
7. 백업 생성 및 별도 복원 리허설, 실제 rollback rehearsal.
8. Mac Safari, Windows Chrome, iPhone Safari의 UI 접근성·터치/키보드 확인.

### K-04. 성능 측정 목표(실측 아닌 Release Gate 후보)
- Fixtures: 미디어 자산 1,000 / 10,000 / 50,000, ASR 구간 10만 이상, 장면 벡터 1만 / 10만 / 100만. 주요 장면 검색/갤러리/백업 경로를 실제 파일 시스템과 synthetic 데이터로 각각 측정.
- 보고 필수: cold/warm, p50/p95/p99 latency, peak RSS, GPU peak VRAM, disk bytes read/write, 전력 차단 후 복구 누락 건수, 재생 오류율.
- **엄격 성공조건:** 안전성 테스트의 원본 오삭제 0건, 조회/WatchTime 이벤트 중복 0건, 오래된 작업 결과 덮어쓰기 0건, 백업 리허설 무결성 100%, 마이그레이션 후 기존 데이터 보존. 성능은 먼저 baseline을 남기고 이후 목표 수치(예: 주요 warm 조회 p95 500ms 이내)를 Release Gate로 확정.

### K-05. GitHub Actions 제안
- `.github/workflows/quality.yml`: Bun lockfile 설치, 타입 검사, 테스트, 웹 build, 각 Python 단위 테스트, 취약점/secret 검사.
- `.github/workflows/integration.yml`: Linux Docker 기반 API/워커/실제 미디어 소형 fixtures, Playwright Chromium/WebKit(가능한 환경에서), API 계약 테스트.
- `.github/workflows/resilience.yml`: 예약/수동 강제 종료, DB restore drill, 오래된 worker fencing, 마운트 결손, 대용량 스캔 비교.
- 실제 GPU 테스트는 GPU runner에서만 동작하도록 별도 태그. 공용 무료 runner가 실제 RTX GPU와 WSL2 환경을 제공한다고 가정하지 않는다.
- PR마다 기존 테스트를 고치지 않고 테스트를 무효화/skip해서 '초록색'으로 만드는 행위 금지. 실패 수정은 재현 테스트와 함께 진행.

## L. PR 단위 변경 순서와 각 작업 완료 정의

| 순서 | PR 묶음 | 주된 변경 | 완료 조건 | 위험 |
|---:|---|---|---|---|
| 00 | Baseline/Backup | ZIP 해시 기록, v15 DB 백업, 테스트/시스템 상태 baseline, git 초기화 또는 새 branch | 원본과 사본이 분리되고 복원 리허설 | 낮음 |
| 01 | Ignore/Compose | secret ignore, 필수 path fail-fast, ASR/scene mount, preflight | 잘못된 경로에서도 빈 미디어 폴더 생성 금지 | 높음 |
| 02 | Library Health | ONLINE/OFFLINE 상태, scanner finalize guard | 전원 분리·작은 라이브러리 오삭제 0건 | 높음 |
| 03 | Mutation Engine | v16, 안전한 영구 삭제·이동 기반, 전담 rw worker | 각 단계 SIGKILL/복구 일관성 | 매우 높음 |
| 04 | Cache/HLS | v17, 세대별 HLS/thumbnail/preview 펜싱 | 동시 인코딩·재생·교체 성공 | 높음 |
| 05 | Auth | v18, Argon2id 점진 전환, server sessions, Rate Limit, trustProxy | 기존 로그인과 새 세션 모두 정상, 복제 세션 폐기 | 중간 |
| 06 | Playback | v19, 세션/이벤트 멱등성, resume race | 재시도 이중 집계 0, 사용자 seek 유지 | 중간 |
| 07 | Viewer/Search UI | next/prev 서버 cursor, random endpoint, 가상화 | 20,000개 이상 목록 일부만 셔플하는 제한 제거 | 중간 |
| 08 | Job Engine | scene 통합 큐, GPU ETA, checkpoint, error code, timeout | GPU 리스/진행/복구 상태 정확 | 높음 |
| 09 | Search | SQLite profiling, FTS5 fallback, 선택적 FAISS index | 결과 정확성+속도 벤치마크 모두 통과 | 중간 |
| 10 | Duplicates | v21, 해시 스캔, 그룹 UI, 검토만 지원 | 정확 중복 오탐/자동 삭제 0 | 중간 |
| 11 | Collections | v22, smart albums/playlists/bookmarks, poster UX | 기존 태그·정렬·기록과 공존 | 낮음~중간 |
| 12 | Bulk/Move | v23, Dry Run/선택 snapshot/개별 작업 | 작업 중단·재시도·승인 정책 통과 | 높음 |
| 13 | Observability | v24, health/diagnostics/notifications/cache policy | 오류 원인 진단 가능, 경고 폭주 없음 | 중간 |
| 14 | Search Index Metadata | v25, FTS/FAISS generation/backfill/GC | 인덱스 재생성 가능, DB 정합성 유지 | 중간 |
| 15 | Hardening/Release | docs, CI, Windows unattended boot rehearsal, E2E, performance | Release checklist 전체 통과 | 높음 |

**PR 선후 조건:** 03은 01/02 완료 후 진행; 04/06/07은 안전한 소스 상태 구분 및 버전 관련 공통 타입을 반영한 뒤; 10~12의 파괴적 기능은 03 안정화 후. 독립적인 UI 개선·테스트/문서는 병렬화 가능하나 동일 `schema.ts` migration 번호 충돌 방지.

### L-01. 위험도에 따른 롤아웃
- **dev:** 별도의 샘플 폴더 및 DB에서 모든 변경 적용.
- **staging:** 운영 DB·미디어 경로의 읽기 전용 복제본, 별도의 Compose 이름 및 포트/볼륨 사용. 원본 데이터와 같은 디렉터리에 rw bind 금지.
- **production canary:** 신규 기능 flag는 처음 OFF. read-only 기능부터 켜고 기존 사용 데이터를 조회/비교. file mutation/대량 정리는 작은 테스트 라이브러리에서 먼저 검증.
- **production:** 업그레이드 전 DB 백업 확인, migrate 1회, 점진적 feature enable, health/데이터 정합성 모니터링. 문제 발견 시 작업 중지→상태 스냅샷→프로세스/서비스 롤백 또는 백업 복원. 작업 큐·격리 파일이 남은 상태에서 DB만 무조건 덮어쓰지 않음.

### L-02. 에이전트에 넘길 공통 작업 지침
1. 업로드 ZIP을 새로운 작업 디렉터리에 안전하게 압축 해제하되 `__MACOSX/` 및 `._` 메타 파일은 무시하고 실제 소스는 보존한다.
2. 파일을 고치기 전에 관련 `schema.ts`, 기존 API DTO, tests를 읽고 변경 영향 범위 표시.
3. 문제를 재현하는 테스트를 먼저 추가. 동일 기능을 새 이름으로 중복 구현하지 말고 기존 함수 리팩터링.
4. 하나의 PR에는 명확한 최종 상태/수정 위치/DB 변경/테스트/롤백 메모가 포함되어야 함.
5. DB migration은 v15부터 순차 진행하고 현재 운영 DB에 직접 테스트하지 않음.
6. 원본 미디어 삭제·이동·변경을 테스트할 때는 fixture만 사용. 원본을 파괴하는 `rm -rf`/`unlink`를 실제 사용자 라이브러리에 실행 금지.
7. 테스트/빌드/린트/타입/통합 결과와 검증하지 못한 항목을 분리하여 보고.
8. 사용자에게 성공이라고 주장하는 항목은 재현 가능한 명령과 테스트 로그를 보유할 것.
9. 기능 플래그를 이용해 점진적으로 배포하고, 각 단계 끝에 `docs/ARCHITECTURE.md`, `docs/RECOVERY.md`, `docs/WINDOWS-OPERATIONS.md`, `README.md` 동기화.
10. 완료된 변경마다 변경 전후 쿼리 지연·GPU/디스크 사용량 및 장애 재현 결과를 문서화하고 기존 회귀 테스트를 유지.

### L-03. 최종 릴리스 Acceptance Checklist
- [ ] 운영 DB v15에서 최신 버전으로 migration 후 기존 asset/library/태그/Vote/리뷰/시청 기록 동일성 확인.
- [ ] 원본 경로/파일 수/해시가 사용자 승인 없는 변경을 겪지 않음.
- [ ] 드라이브 연결 해제·빈 마운트·I/O 오류에서 자동 자산 삭제 0건.
- [ ] 파일 삭제/이동의 모든 중간 단계 kill/retry 정합성 검증.
- [ ] HLS 재생 중 새 인코딩 게시·GC·고장 복구 가능.
- [ ] Direct Play/Remux/Full HLS 및 Safari/Chrome 기본 재생 성공.
- [ ] 뷰어의 빠른 전환·셔플·next/prev에서 stale 데이터 덮어쓰기 0건.
- [ ] 동일 재생 이벤트를 여러 번 보내도 조회/WatchTime 추가는 한 번만.
- [ ] ASR·Scene이 추가 등록 드라이브의 미디어를 정상 읽음.
- [ ] 모든 AI 파이프라인(scene 포함) 작업/실패/GPU 리스가 한 화면에 정확히 표시.
- [ ] 모델 버전과 파일 버전 변경 시 stale 추론 결과 게시 금지.
- [ ] 파일 중복 후보·스마트 앨범·일괄 처리·시점 북마크·재생목록 기본 UX 동작.
- [ ] 이미지 입력 장면 검색, AI 챕터, 자막 편집기는 존재하지 않음(기존 자막 보기/번역/다운로드 기능은 유지).
- [ ] 로그인/세션 폐기/Rate Limit/비밀값 보호 검증, no secrets in image/logs.
- [ ] 백업 및 실제 분리된 복원 리허설 통과.
- [ ] Windows 재부팅/로그오프/WSL2 재기동/SSH 접속/드라이브 재연결 테스트.
- [ ] 앱 내 진단 및 오류 알림 시 민감정보 노출 없음.
- [ ] Bun/Python 테스트, 웹 빌드, Compose 검증, Playwright E2E, 장애 주입 테스트 성공.
- [ ] 측정하지 않은 성능 향상을 성공으로 표시하지 않고 benchmark 수치 제출.

## M. 참고한 공개 자료 (구현 가이드: 현행 문서 확인 후 버전 고정)
- Docker Compose long bind mount `create_host_path`: https://docs.docker.com/reference/compose-file/services/#long-syntax-5
- SQLite WAL & checkpoint: https://www.sqlite.org/wal.html
- SQLite backup API / `VACUUM INTO`: https://sqlite.org/backup.html
- SQLite FTS5 trigram: https://www.sqlite.org/fts5.html
- SQLite `PRAGMA optimize`: https://www.sqlite.org/pragma.html
- Bun SQLite runtime/extension: https://bun.com/docs/runtime/sqlite
- Bun password Argon2id: https://bun.com/docs/runtime/hashing
- OWASP Password Storage: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- FFmpeg progress and options: https://www.ffmpeg.org/ffmpeg.html
- hls.js recovery API and design: https://github.com/video-dev/hls.js
- TanStack Infinite Query (`maxPages`): https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries
- FAISS: https://github.com/facebookresearch/faiss
- sqlite-vec: https://github.com/asg017/sqlite-vec
- Immich: https://github.com/immich-app/immich
- Paperless-ngx: https://github.com/paperless-ngx/paperless-ngx
- Czkawka: https://github.com/qarmin/czkawka
- Jellyfin: https://github.com/jellyfin/jellyfin
- Stash: https://github.com/stashapp/stash
- Microsoft WSL file system best practices: https://learn.microsoft.com/windows/wsl/filesystems

---

**상태 표기:** 이 문서는 소스 ZIP 직접 검토에 근거한 **설계 결정을 기록**한 것이며, 실제 코드 변경·제품 출시·실 GPU/Windows 운영 검증 완료 선언이 아니다. 실행은 위 PR 순서에 따라 테스트 및 승인 게이트를 통과하며 수행한다.
