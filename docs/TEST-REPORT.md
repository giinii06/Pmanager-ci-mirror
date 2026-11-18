# 테스트 및 실서버 검증 보고서

## 1. 로컬 단위·통합·크래시 테스트 스위트

| 구분 | 범위 | 결과 |
| --- | --- | --- |
| TypeScript 타입 검사 | `bun run typecheck` (6개 워크스페이스) | 0 errors |
| 전체 단위/통합 테스트 | `bun test` (34개 파일) | `284 pass, 0 fail` |
| 웹 프로덕션 빌드 | `bun run --cwd apps/web build` | `vite build` 프로덕션 번들 성공 |
| Python ASR 테스트 | `apps/asr-worker/.venv/bin/pytest` | `110 passed, 1 skipped` |

### 주요 신규 릴리스 게이트 테스트 (`apps/worker/src/crash-recovery.test.ts`, `apps/api/src/fs-and-ops.test.ts`, `apps/web/src/lib/justified.test.ts`)

1. **1,000개 파일 스캔 중단 + 오프라인 변조 후 정합성 100% 일치**: 500개 이상에서 중단 후 커서 앞 파일 추가(`000-added-before-cursor.jpg`), 커서 횡단 이동(`001-moved-before-cursor.jpg`), 기존 파일 삭제 후 재개한 스캔 결과가 대조군 전체 스캔 결과와 100% 일치 (오삭제 0건).
2. **만료 리스 펜싱 + `.tmp` 정리 + 썸네일 보호**: 만료 워커(`lease_epoch = 1`)의 `completeJob` 거부, 새 워커(`lease_epoch = 2`) 정상 완료, 오래된 `.tmp` 삭제 검증.
3. **체크포인트 저장 중 리스 상실(`lease_lost`) 원자적 롤백**: 다른 워커가 `lease_epoch`를 선점한 상태에서 `saveJobCheckpoint`가 실패하면 해당 배치 트랜잭션을 통째로 롤백하여 부분 에셋·체크포인트 오염 방지.
4. **취소된 스캔 비부활 및 일시정지 스캔 수동 재개**: 대기 중 스캔 취소 시 `libraries.scan_state = 'idle'`·`scan_checkpoints`를 정리해 주기 복구에서 되살아나지 않으며, 일시정지된 스캔은 `POST /api/libraries/:id/scan` 호출 시 즉시 재개됨.
5. **빈 마운트포인트 및 시스템 경로/심볼릭 링크 심층 차단**: `SCAN_DELETE_FORCE=true` 상태에서도 `drives/e`가 비어 있으면 `drive_unavailable`로 차단하며, `realpath` 이후 경유 경로가 `Windows` 등 시스템 폴더에 닿는 심볼릭 링크 체인도 `403 blocked_system_path`로 차단.
6. **스토리지 집계 이중 합산 방지 및 타임존 독립 Vote 달력**: `totalLibraryBytes`에서 `tempBytes` 중복 합산 제거, OS 로컬 타임존과 무관한 `DAY_FORMATTER` 기준 KST 자정 직후 `vote_events` 집계·스트릭 일치, 초협폭(280px) 컨테이너 파노라마 타일 가로 오버플로 방지 검증.
7. **`VACUUM INTO` 백업 및 복원 무결성**: 백업 생성 후 `PRAGMA integrity_check = ok` 확인 및 임시 파일 교체·사이드카 제거 복원 검증.

## 2. Win11 실서버(`192.168.0.27`) 라이브 검증 결과

- **Schema v14 무손실 마이그레이션**: `user_version = 14`, `synchronous = 2 (FULL)`, `assets = 13,080`, `folders = 113`, `views = 3` 보존.
- **헬스 체크**: `/health/live`, `/health/ready`, Win11 `scripts/windows/check-health.ps1` 모두 `200` / `True` 응답 (`/health/ready`는 풀 B-tree 스캔을 피하기 위해 기본적으로 `dbIntegrity: "skipped"`를 반환하고 `/api/system/status`가 60초 TTL로 `PRAGMA quick_check(1)` 결과를 캐시함).
- **드라이브 탐색기 및 보안**: `/api/fs/drives`에서 `C:\`, `D:\`, `E:\` 용량 포함 조회, `/api/fs/browse?path=drives/c/Windows` HTTP `403` 차단 확인.
- **수동 DB 백업**: `POST /api/backups` -> `mediavault-2026-11-18T03-25-13-870Z-mwxsyb.db` (`334,450,688` bytes, `integrity: ok`).
- **실시간 워커 크래시 자동 복구**: 호스트에서 실행 중인 `mediavault-worker-1` PID `157691`에 커널 `SIGKILL` 전송 후 **5초** 만에 새 PID `158150`으로 자동 재기동되고 `recovery_logs` (`id = 5`, `db_integrity = ok`)가 기록되었으며, 만료 리스 작업 `15468`도 에포크 `2`로 재개되어 `13,080`건 무손실 완료.

## 3. 사용자 수동 확인 필요 항목 (관리자 권한 및 물리 테스트)

1. Win11 관리자 PowerShell에서 `scripts/windows/install-service.ps1` 1회 실행 (UAC 승인 필요).
2. ASRock `B650M PG Lightning` BIOS에서 `Restore on AC/Power Loss -> Power On` 설정.
3. 실제 물리적 로그오프·재부팅·전원 차단 테스트 (SSH 원격 세션 범위 밖).
