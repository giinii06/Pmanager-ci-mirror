# MediaVault 시스템 아키텍처 (Schema v26)

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

## 2. 데이터베이스 스키마 주요 확장 (v14 → v26)

마이그레이션은 `packages/database/src/schema.ts`의 `MIGRATIONS[index]`가 버전 `index + 1`에 해당하며, 모두 추가 전용입니다. `openDatabase()`가 접속 시 하나의 `IMMEDIATE` 트랜잭션에서 적용하고 `PRAGMA user_version`을 기록합니다. 읽은 버전이 `SCHEMA_VERSION` 이상이면 즉시 반환하므로, 이전 바이너리는 더 새로운 스키마를 그대로 열어 읽을 수 있습니다(모르는 테이블·컬럼은 무시).

`v14` 기준선:

- `jobs`: `worker_id`, `lease_epoch`, `lease_expires_at`, `progress_current`, `progress_total`, `phase`, `checkpoint`, `pause_requested`, `cancel_requested`, `completed_at`, 일시정지 중복 방지 인덱스 `ux_jobs_active` (`queued`, `running`, `paused`).
- `folders`: 중앙 커버 크기/버전 캐시 컬럼 (`cover_width`, `cover_height`, `cover_poster_version`, `coverFileVersion` URL 캐시 버스팅) 및 백분율 `rate`.
- `scan_runs`, `scan_checkpoints`: 라이브러리 스캔 단계별 진행 상태 및 트랜잭션 체크포인트.
- `vote_events`: 폴더 및 동영상 Vote 활동을 기여(`contribution_events`)와 분리 추적.
- `recovery_logs`, `backup_logs`: 크래시 복구 및 `VACUUM INTO` 무결성 검증 백업 이력.

`v15`–`v22`:

- PR 02–06이 `library_health`와 `scan_runs` 확장(`v16`), `file_mutations`/`mutation_events`(`v17`), `hls_generations`/`hls_active`(`v18`), `user_sessions`/`auth_login_attempts`/`auth_events`(`v19`), `play_sessions`/`play_events`와 `playback_progress` 확장(`v20`)을 추가했습니다. PR 07과 PR 08은 스키마를 바꾸지 않았고, PR 08b가 `stage_checkpoints`와 `scene_jobs.analyzed_windows`/`total_windows`(`v21`), PR 10이 `file_fingerprints`/`duplicate_groups`/`duplicate_group_members`(`v22`)를 추가했습니다.

`v23`–`v26`:

- `v23` — `smart_albums`(저장 필터 JSON + `filter_version`, 사용자별 이름 유니크), `playlists`/`playlist_items`(`watch_later`는 사용자당 하나만 허용하는 부분 유니크 인덱스), `video_bookmarks`(`position_ms`와 `file_version` 스냅샷).
- `v24` — `bulk_operations`/`bulk_operation_items`. 대상 집합과 항목별 결과를 동결해 두고, 항목 행에는 자산 FK를 걸지 않습니다(삭제 성공 뒤에도 무엇을 했는지 보고해야 하므로). `file_mutations`에 `target_library_id`/`target_rel`을 추가해 이동을 표현합니다.
- `v25` — `notifications`/`notification_delivery_attempts`, `diagnostics_runs`, `worker_heartbeats`(Docker가 `worker_id`를 재사용하므로 부팅마다 새 `instance_id`), `cache_cleanup_runs`, 그리고 `jobs.request_id` + 부분 인덱스.
- `v26` — `search_index_builds`/`search_index_active`. 색인을 만든 출처(`bootstrap`/`operator`/`boot-repair`), 검증 시각, 자산·구간 워터마크를 행으로 남기고, 활성 포인터가 `ready` 행만 가리키도록 네 개 트리거가 강제합니다. FTS5 외부 콘텐츠 테이블(`asset_search`, `segment_search`)과 동기화 트리거는 스키마가 아니라 `configureSearchFts()`가 만듭니다.

## 3. 호스트 드라이브 노출 구조

`compose.yaml`은 기존 `/media` 및 `/media/extra`를 보존한 채 호스트의 Windows 드라이브를 `/media/drives/c`, `/media/drives/d`, `/media/drives/e`로 마운트합니다. 기본 샘플 미디어 경로와 분리되므로 기존 라이브러리 ID(`npgghj7vxgn4`, `extra/d`)와 데이터가 그대로 유지됩니다.

## 4. 통합 작업 큐와 GPU 정책

- `packages/database/src/work-queue.ts`의 `workQueue`는 `jobs`(미디어·스캔), `asr_jobs`, `translation_jobs`, `embedding_jobs`, `scene_jobs`, `file_mutations`를 하나의 읽기 모델로 합칩니다. 표시용 파이프라인은 `media|asr|translation|embedding|scene|mutation|backup|maintenance|bulk` 아홉 개이며, 저장 테이블은 그대로 유지됩니다. `jobs` 테이블을 쓰는 두 레인은 `kind`로 갈립니다: `media`는 `kind <> 'maintenance'`, `maintenance`(중복 스캔 등)는 `kind = 'maintenance'`만 조회하므로 한 작업이 두 레인에 중복 집계되지 않습니다.
- GPU 작업(ASR·번역·임베딩·장면)은 `gpu_leases`의 단일 카드 리스를 공유합니다. `runningGpu`(리스 보유)와 `waitingGpu`(실행 중이지만 리스 대기)를 분리해 표시하고, 대기 중인 작업의 ETA에는 현재 리스 보유 작업의 남은 시간과 자기 작업의 최근 중앙값을 더합니다. 각 단계가 리스를 잡은 뒤 모델을 올리므로 그 중앙값에는 모델 로딩이 이미 포함됩니다.
- `claimNextJob`은 2분마다 우선순위를 한 단계 승격해 오래 기다린 작업이 굶지 않게 합니다. 유효 우선순위가 같으면 원래 우선순위가 앞섭니다.
- 장면 작업은 `scene_jobs.window_ms`/`overlap_ms`와 `SCENE_MAX_WINDOWS`로 계획된 구간 수를 계산해 전체 구간 수와 함께 표시합니다(`coverage`). 자동 챕터가 아니라 검색 색인의 샘플링 범위입니다.
- ETA는 최근 7일 완료 작업의 중앙값(최소 3개)만 사용합니다. 표본이 부족하면 숫자 대신 `basis: 'insufficient_data'`를 반환합니다.

## 5. 작업 오류 코드와 프로세스 수명

- 실패 코드는 `packages/shared/src/domain.ts`의 `JOB_ERROR_CODES` 14종이며, 기존 오류 컬럼에 `[CODE] 메시지` 형태로 저장됩니다. 접두사가 없는 과거 행은 코드 없이 원래 메시지를 유지합니다.
- `SOURCE_OFFLINE`과 `DISK_FULL`은 재시도 횟수를 소모하지 않고 즉시 `failed`로 주차됩니다. `recovery.ts`는 라이브러리가 `ONLINE`이 된 뒤 `[SOURCE_OFFLINE]` 행을 최대 100개까지 재큐합니다(활성 중복 키가 있으면 건너뜀).
- Node ffmpeg는 자체 프로세스 그룹에서 실행되며 벽시계 상한과 진행 정지 감시를 가집니다. 취소·타임아웃 시 그룹 전체에 SIGKILL을 보내고, stderr는 8KB 꼬리만 보관합니다.
- Python 장면 워커는 모든 외부 프로세스를 `run_checked`로 실행합니다. 자체 세션 그룹에 TERM → 10초 → KILL 순서로 종료하고, 단계 전체에도 `SCENE_STAGE_TIMEOUT_SECONDS`(기본 3600초) 상한이 있습니다.

## 6. 단계 체크포인트와 재개

- 장면 단계는 끝난 윈도우를 `SCENE_CHECKPOINT_DIR/<jobId>/windows.jsonl`에 한 줄씩 append하고 fsync합니다. 썸네일도 로그보다 먼저 fsync하며, 5개마다(그리고 마지막 윈도우에서) `manifest.json`을 임시 파일 → fsync → `os.replace` → 디렉터리 fsync 순서로 교체합니다. 그 뒤에야 부모가 API에 `POST /worker/scene/jobs/:id/checkpoint`를 보냅니다.
- `stage_checkpoints` 행은 job/stage 단위 포인터일 뿐입니다. 재개할 때는 로그를 먼저 읽고, 매니페스트의 `meta`(asset, fileVersion, 모델 SHA, 파이프라인 버전, 차원, 윈도우 계획)가 현재 계획과 같을 때만 prefix를 재사용합니다. 중간에 잘린 줄, seq 불연속, 사라진 썸네일을 만나면 그 지점에서 prefix를 자르고 이후 윈도우만 다시 처리합니다.
- 로그가 매니페스트보다 앞서면 로그가 이깁니다(매니페스트 재작성). 매니페스트가 없거나 meta가 다르면 로그를 폐기하고 처음부터 처리합니다. API는 모델 fingerprint나 pipelineVersion이 다른 행을 발견하면 삭제하고 `checkpoint: null`을 반환합니다.
- 완료 시 `completeSceneJob`이 `analyzed_windows`/`total_windows`를 기록하고 체크포인트 행을 지웁니다. 워커도 완료 응답을 받은 뒤 디렉터리를 정리합니다. `GET /api/assets/:id/scenes`는 이 값으로 샘플링 커버리지(`N/M 구간`)를 돌려주며, PR 08b 이전에 완료된 작업은 `null`입니다.

## 7. 중복 검토

- **정책**: 정확히 같은 바이트의 파일 후보는 강하게 판별하지만 자동 삭제하지 않습니다. 이 PR의 어떤 경로도 파일을 쓰기용으로 열지 않고, `file_mutations` 행을 만들지 않으며, 삭제·격리·이동 잡을 큐에 넣지 않습니다. `POST /api/duplicates/groups/:id/decisions`의 `action: "delete"`는 `409 delete_not_available`로 거절합니다.
- **해시 파이프라인** (`apps/worker/src/duplicates/hash.ts`): 크기 히스토그램으로 같은 크기를 공유하는 자산만 후보로 뽑고(`duplicateCandidates`), 후보의 앞·중간·끝 1 MiB씩(총 3 MiB)을 읽어 quick hash를 만듭니다. 3 MiB 이하 파일은 통째로 읽히므로 quick hash가 곧 full hash입니다(`quickCoversWhole`). 같은 `(크기, quick hash)` 버킷에 2개 이상이 있을 때만 1 MiB 청크 스트리밍으로 full SHA-256을 계산합니다. 읽기 전후 `stat`이 size/mtime/ino/dev 중 하나라도 다르면 `UnstableFileError`로 해시를 버립니다.
- **그룹**: 그룹 키는 `(size_bytes, full_hash)`이고 fingerprint는 `sha256:<bytes>:<hex>`입니다. 그룹 id는 `dup_` + `sha256('exact:' + fingerprint)` 앞 16 hex라서 같은 바이트는 몇 번을 스캔해도 같은 행에 떨어지고, 검토자가 남긴 `kept`/`ignored`가 다음 스캔에서도 유지됩니다(`ON CONFLICT DO UPDATE SET updated_at`만 갱신).
- **하드링크**: `file_fingerprints`의 `device_id`/`inode`와 `duplicate_group_members.same_inode`로 같은 바이트를 공유하는 두 경로를 구분합니다. 하드링크 쌍은 진짜 중복이지만 한쪽을 지우면 둘 다 사라지므로 UI가 경고할 수 있어야 합니다. inode를 모르는 행은 절대 하드링크로 취급하지 않습니다.
- **읽기 경로**: 살아 있는 멤버가 2개 미만인 그룹은 목록에도 상세에도 나오지 않습니다. 에셋이 소프트 삭제되면 다음 스캔이 그룹을 정리할 때까지 그 그룹은 사라진 것으로 보입니다.
- **유사 중복은 미구현**: 지각 해시(pHash) 기반 `similar` 그룹은 스펙의 후속 항목입니다. `kind=similar` 목록은 DB를 읽지 않고 `{groups: [], nextCursor: null}`을 반환합니다.
- **화면** (`apps/web/src/pages/DuplicatesPage.tsx`, 사이드바 `중복 검토`): `검토 전/유지/무시/전체` 필터, 6초 폴링 무한 스크롤, `스캔 시작`(202 응답의 잡 id만 받고 큐 화면을 무효화), 멤버별 썸네일·경로·해상도/길이·라이브러리, 하드링크 배지, 그룹 단위 `모두 유지`/`무시`. 절약 가능 용량은 그룹 총량에서 가장 큰 멤버를 뺀 값이며, 특정 멤버를 지목하지 않습니다. 삭제 버튼은 UI에 존재하지 않습니다.
