# MediaVault 시스템 아키텍처 (Schema v20)

MediaVault는 Windows 11 호스트(WSL2 Ubuntu 24.04 + 네이티브 Docker Engine)에서 상시 운영되며, macOS를 비롯한 LAN 브라우저에서 접속하는 셀프 호스팅 사진·동영상 라이브러리 서버입니다.

## 1. 전체 구성

- **프런트엔드 (`apps/web`)**: React 19, Vite 8, Tailwind CSS v4, `@tanstack/react-query`, `@tanstack/react-virtual`.
  - 무깜빡임 `Dark` / `Light` / `System` 테마 (`apps/web/index.html` 인라인 사전 페인트 스크립트 + `src/store/ui.ts` + `src/styles.css` CSS 변수 토큰).
  - 월별 헤더 제거 및 원본 종횡비 보존 고밀도 갤러리 (`apps/web/src/lib/justified.ts`, `Thumb.tsx`, `AssetTile.tsx`).
  - 파일명 오름차순 중앙 이미지 커버(`coverWidth` / `coverHeight`) 기반 메이슨리 폴더 카드 및 호버/모바일 `정보` 오버레이 (`FolderCard.tsx`, `FolderPages.tsx`).
  - Safari/모바일 대응 커스텀 동영상 플레이어(`VideoPlayer.tsx`, 네이티브 컨트롤 제거로 단일 전체화면 보장, 언마운트 시 디코더 정리) 및 `정보` 버튼 옆 `Shuffle` 배치 (`WatchPage.tsx`).
  - Win11 드라이브 탐색 모달(`HostFolderPicker.tsx`), 기여 잔디(초록) + Vote 기반 **주황색 잡초(`Vote Activity`)**, 서버 상태·복구·백업·작업 제어 UI (`SettingsPage.tsx`, `ProcessingPanel.tsx`).
- **백엔드 API (`apps/api`)**: Fastify + `bun:sqlite`.
  - 인증된 미디어 호스트 탐색기 (`/api/fs/drives`, `/api/fs/browse`), `realpath` 검증 포함 심볼릭 링크·시스템 디렉터리·`..` 상위 경로·UNC 경로 차단 및 `(dev, ino)` 중복 라이브러리 등록 방지 (`routes/fs.ts`, `routes/libraries.ts`).
  - 운영 및 복구 API (`/health/live`, `/health/ready` 무블로킹 프로브, `/api/system/status` 60초 TTL `PRAGMA quick_check(1)` 캐시, `/api/backups`, `/api/stats/votes-activity`, `/api/jobs/:id/{pause,resume,cancel}`).
- **백그라운드 워커 (`apps/worker`)**:
  - 2단계 체크포인트 스캐너 (`scan.ts`): 1단계 재개 가능한 배치 인덱싱 (`BATCH_SIZE = 250`)과 2단계 전체 검증 순회 (`verify`) 분리로 중단/재개 후 파일 추가·이동·삭제가 발생해도 오삭제 없이 완결.
  - 단조 증가 `lease_epoch` 펜싱 (`loop.ts`, `handlers.ts`, `packages/database/src/jobs.ts`).
  - 등록된 라이브러리 루트만 추적하는 디렉터리 `mtime` 폴러 (`watch.ts`), WSL2 DrvFS 환경에서도 유휴 CPU 1% 미만 유지.
  - 기동/주기 자동 복구 (`recovery.ts`): 만료 리스 복구, 고아 `scan_runs` 상태 정리, 임시 `.tmp` 정리, 썸네일 정합성 복구, `recovery_logs` 기록.
- **데이터베이스 (`packages/database`)**: SQLite (`3.53.4` Linux 컨테이너 / `3.54.0` macOS) WAL + `PRAGMA synchronous = FULL` + `PRAGMA busy_timeout = 10000` (기동 락 재시도 포함).

## 2. 데이터베이스 스키마 v14 주요 확장

- `jobs`: `worker_id`, `lease_epoch`, `lease_expires_at`, `progress_current`, `progress_total`, `phase`, `checkpoint`, `pause_requested`, `cancel_requested`, `completed_at`, 일시정지 중복 방지 인덱스 `ux_jobs_active` (`queued`, `running`, `paused`).
- `folders`: 중앙 커버 크기/버전 캐시 컬럼 (`cover_width`, `cover_height`, `cover_poster_version`, `coverFileVersion` URL 캐시 버스팅) 및 백분율 `rate`.
- `scan_runs`, `scan_checkpoints`: 라이브러리 스캔 단계별 진행 상태 및 트랜잭션 체크포인트.
- `vote_events`: 폴더 및 동영상 Vote 활동을 기여(`contribution_events`)와 분리 추적.
- `recovery_logs`, `backup_logs`: 크래시 복구 및 `VACUUM INTO` 무결성 검증 백업 이력.

이후 PR 02–06이 `v16`–`v20`을 추가했다: `library_health`와 `scan_runs` 확장(`v16`), `file_mutations`/`mutation_events`(`v17`), `hls_generations`/`hls_active`(`v18`), `user_sessions`/`auth_login_attempts`/`auth_events`(`v19`), `play_sessions`/`play_events`와 `playback_progress` 확장(`v20`). PR 07과 PR 08은 스키마를 바꾸지 않았다.

## 3. 호스트 드라이브 노출 구조

`compose.yaml`은 기존 `/media` 및 `/media/extra`를 보존한 채 호스트의 Windows 드라이브를 `/media/drives/c`, `/media/drives/d`, `/media/drives/e`로 마운트합니다. 기본 샘플 미디어 경로와 분리되므로 기존 라이브러리 ID(`npgghj7vxgn4`, `extra/d`)와 데이터가 그대로 유지됩니다.

## 4. 통합 작업 큐와 GPU 정책

- `packages/database/src/work-queue.ts`의 `workQueue`는 `jobs`(미디어·스캔), `asr_jobs`, `translation_jobs`, `embedding_jobs`, `scene_jobs`, `file_mutations`를 하나의 읽기 모델로 합칩니다. 표시용 파이프라인은 `media|asr|translation|embedding|scene|mutation|backup|maintenance|bulk` 아홉 개이며, 저장 테이블은 그대로 유지됩니다.
- GPU 작업(ASR·번역·임베딩·장면)은 `gpu_leases`의 단일 카드 리스를 공유합니다. `runningGpu`(리스 보유)와 `waitingGpu`(실행 중이지만 리스 대기)를 분리해 표시하고, 대기 중인 작업의 ETA에는 현재 리스 보유 작업의 남은 시간과 자기 작업의 최근 중앙값을 더합니다. 각 단계가 리스를 잡은 뒤 모델을 올리므로 그 중앙값에는 모델 로딩이 이미 포함됩니다.
- `claimNextJob`은 2분마다 우선순위를 한 단계 승격해 오래 기다린 작업이 굶지 않게 합니다. 유효 우선순위가 같으면 원래 우선순위가 앞섭니다.
- 장면 작업은 `scene_jobs.window_ms`/`overlap_ms`와 `SCENE_MAX_WINDOWS`로 계획된 구간 수를 계산해 전체 구간 수와 함께 표시합니다(`coverage`). 자동 챕터가 아니라 검색 색인의 샘플링 범위입니다.
- ETA는 최근 7일 완료 작업의 중앙값(최소 3개)만 사용합니다. 표본이 부족하면 숫자 대신 `basis: 'insufficient_data'`를 반환합니다.

## 5. 작업 오류 코드와 프로세스 수명

- 실패 코드는 `packages/shared/src/domain.ts`의 `JOB_ERROR_CODES` 14종이며, 기존 오류 컬럼에 `[CODE] 메시지` 형태로 저장됩니다. 접두사가 없는 과거 행은 코드 없이 원래 메시지를 유지합니다.
- `SOURCE_OFFLINE`과 `DISK_FULL`은 재시도 횟수를 소모하지 않고 즉시 `failed`로 주차됩니다. `recovery.ts`는 라이브러리가 `ONLINE`이 된 뒤 `[SOURCE_OFFLINE]` 행을 최대 100개까지 재큐합니다(활성 중복 키가 있으면 건너뜀).
- Node ffmpeg는 자체 프로세스 그룹에서 실행되며 벽시계 상한과 진행 정지 감시를 가집니다. 취소·타임아웃 시 그룹 전체에 SIGKILL을 보내고, stderr는 8KB 꼬리만 보관합니다.
- Python 장면 워커는 모든 외부 프로세스를 `run_checked`로 실행합니다. 자체 세션 그룹에 TERM → 10초 → KILL 순서로 종료하고, 단계 전체에도 `SCENE_STAGE_TIMEOUT_SECONDS`(기본 3600초) 상한이 있습니다.
