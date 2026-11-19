# 크래시 복구, 데이터 무결성 및 백업/복원 가이드

이 문서는 갑작스러운 정전이나 비정상 종료 후 MediaVault가 데이터를 보호하고 자동 복구하는 메커니즘과 수동 복원 절차를 설명합니다.

## 1. 데이터베이스 내구성 및 락 안전성

- `packages/database/src/db.ts`는 연결 시 다음 순서를 강제합니다.
  1. `PRAGMA busy_timeout = 10000` (기동 동시 락 대기)
  2. `PRAGMA journal_mode = WAL` + `PRAGMA synchronous = FULL` + `PRAGMA foreign_keys = ON` + `Bun.sleepSync` 기반 `SQLITE_BUSY` 재시도 루프 (`runBusyRetry`)
  3. 버전 검증 후 단일 트랜잭션 마이그레이션
- 컨테이너 `/data`는 WSL2 ext4 Docker 볼륨에 위치하여 Windows DrvFS 파일 잠금 문제 없이 POSIX atomic `fsync`가 동작합니다.
- 번들 SQLite 버전은 컨테이너 `3.53.4`, 로컬 `3.54.0`으로 WAL 체크포인트 내구성 수정(`>= 3.51.3`)이 반영된 버전입니다.

## 2. 단조 `lease_epoch` 펜싱 및 작업 상태 모델

- 작업 상태는 `queued`, `running`, `paused`, `cancelled`, `done`, `failed` 6단계로 관리됩니다.
- 워커가 작업을 `claimNextJob`할 때마다 `lease_epoch = lease_epoch + 1`이 증가합니다.
- `heartbeatJob`, `saveJobCheckpoint`, `completeJob`, `failJob`, `pauseRunningJobWithFence`, `requeueInterruptedJobWithFence`, `cancelRunningJobWithFence`는 모두 `WHERE id = ? AND state = 'running' AND worker_id = ? AND lease_epoch = ? AND lease_expires_at > ?` 조건으로 펜싱합니다. 만료된 워커가 늦게 완료 응답을 보내도 덮어쓸 수 없습니다.
- `ux_jobs_active` 인덱스는 `paused` 상태에도 중복 큐 예약을 유지하므로 일시정지된 스캔이 중복 실행으로 리셋되지 않습니다.

## 3. 스캔 재개와 삭제 검증 분리

1. **1단계 (`index`)**: 250건마다 `scan_checkpoints` 및 `jobs.checkpoint`를 WAL 트랜잭션으로 저장합니다. `SIGINT`/`SIGTERM` 또는 일시정지 시 버퍼를 플러시하고 안전하게 중단합니다.
2. **2단계 (`verify`)**: 체크포인트에서 재개(`resumedFromCheckpoint = true`)된 스캔은 커서 이후를 빠르게 인덱싱한 뒤 **반드시 전체 트리를 한 번 더 검증 순회(`authoritativeScanId`)**합니다. 중단 동안 커서 뒤쪽에서 파일이 추가·이름변경·삭제되어도 오삭제가 발생하지 않습니다.
3. **마운트 끊김 차단**: 루트 접근 불가, 읽기 오류(`readErrors > 0`), 또는 기존 에셋이 있는데 `/media`, `extra`, `drives/{c,d,e}` 루트가 비어 있으면 `SCAN_DELETE_FORCE=1`과 무관하게 삭제를 차단(`drive_unavailable`)합니다.
4. **원자적 썸네일 게시**: `writeAtomic`은 `.tmp` 파일 생성·비어 있지 않음 확인 후 `canPublish()`로 현재 리스 에포크와 `file_version`을 재검사한 뒤 `rename`합니다.

## 4. 백업 및 복원 절차

### 자동 및 UI 백업

- 워커(`apps/worker/src/loop.ts`)는 24시간마다 `/data/backups`에 `VACUUM INTO` 백업을 생성하고 최근 14개를 보존하며 `PRAGMA integrity_check`를 검증합니다 (`getLatestBackupLog(db, true)`로 성공 이력 기준 스케줄링, 실패 파일 즉시 삭제). `restoreDatabaseBackup`은 임시 파일 복사 및 `-wal`/`-shm` 사이드카 제거 후 `renameSync`로 원자적 교체를 수행합니다.
- 설정 화면의 **서버 상태 · 복구 · 데이터베이스 백업** 섹션에서 **지금 DB 백업** 버튼(`POST /api/backups`)으로 즉시 생성할 수 있습니다.

### 수동 복원 Runbook

```bash
ssh media-server
cd ~/Pmanager
# 1. API와 워커 정지 (nginx/web 유지 가능하나 정합성을 위해 api/worker 중지)
docker compose ... stop api worker

# 2. 현재 백업 목록 확인 (예: /data/backups 또는 ~/Pmanager-backups)
docker run --rm -v mediavault_mediavault-data:/data -v ~/Pmanager-backups:/hostbak alpine \
  sh -c 'ls -lh /data/backups /hostbak'

# 3. 선택한 백업으로 복원 (-wal, -shm 사이드카 반드시 제거 후 복사)
docker run --rm -v mediavault_mediavault-data:/data alpine \
  sh -c 'rm -f /data/mediavault.db-wal /data/mediavault.db-shm && cp /data/backups/<선택한백업>.db /data/mediavault.db'

# 4. 무결성 확인 및 기동
docker compose ... up -d api worker
```

## 5. 로그인·세션 복구

세션은 서버 측 `user_sessions` 행이며 쿠키에는 256비트 토큰만 들어간다. DB에는 토큰의 HMAC 다이제스트만 저장되므로 DB 사본으로 로그인할 수는 없지만, 운영자는 다음 두 가지를 알아야 한다.

### 비밀번호를 잊었을 때

복구 엔드포인트는 의도적으로 없다. 대신 오프라인 스크립트가 Argon2id 해시를 다시 쓰고 모든 세션을 폐기한다.

```bash
# API를 먼저 멈춘다. 실행 중인 WAL DB에 스크립트를 돌리지 않는다.
docker compose ... stop api
printf '%s\n' '<새 비밀번호>' | docker exec -i mediavault-api-1 bun scripts/reset-password.ts --user <계정>
docker compose ... start api
```

사용자가 둘 이상이면 `--user`가 필수이고, 없으면 스크립트가 계정 목록을 출력하고 종료한다.

### 강제 로그아웃

`POST /api/auth/logout-all`은 그 사용자의 모든 세션을 폐기한다. 특정 세션만 끊으려면 `GET /api/auth/sessions`로 `id`를 확인한 뒤 `DELETE /api/auth/sessions/:id`를 호출한다. 비밀번호를 바꾸면 기존 세션이 전부 폐기되고 현재 브라우저에 새 세션이 발급된다.

### 자동 점검용 세션

`docker exec mediavault-api-1 bun scripts/mint-session.ts`가 30일 세션을 만들고 `mv_session=<token>`을 출력한다. 스키마 `v19` 이전의 HMAC 서명 토큰은 더 이상 받지 않는다.
