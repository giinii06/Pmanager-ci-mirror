# MediaVault 시스템 아키텍처 (Schema v14)

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

## 3. 호스트 드라이브 노출 구조

`compose.yaml`은 기존 `/media` 및 `/media/extra`를 보존한 채 호스트의 Windows 드라이브를 `/media/drives/c`, `/media/drives/d`, `/media/drives/e`로 마운트합니다. 기본 샘플 미디어 경로와 분리되므로 기존 라이브러리 ID(`npgghj7vxgn4`, `extra/d`)와 데이터가 그대로 유지됩니다.
