# 테스트 및 릴리스 검증 보고서

최종 갱신: 2026-11-21, `main` 기준. 아래 수치는 마지막 `bun run release:check` 실행과 호스트 라이브 점검에서 나온 값입니다.

## 1. 자동 게이트

`bun run release:check`가 아래를 순서대로 실행하고, 하나라도 실패하면 거기서 멈춥니다. 정의는 `scripts/release-check.ts` 한 곳에만 있습니다.

| 게이트 | 확인하는 것 | 결과 |
| --- | --- | --- |
| version | `APP_VERSION`과 루트 `package.json`의 `version` 일치 | `1.0.0` |
| typecheck | 6개 워크스페이스 + 루트 프로젝트 | exit `0` |
| test | `bun test` 전체 | `721 pass, 0 fail`, 81개 파일, 4,665 expect |
| build | `apps/web` Vite 프로덕션 빌드 | exit `0`, 2,971 modules, `index-DkBWFB8k.js` 593.34 kB |
| smoke | 실제 API·워커 기동 후 HTTP 확인 | `Smoke test passed.` |

- **smoke**는 임시 데이터 디렉터리에 계정을 만들고 라이브러리를 등록한 뒤 3개 자산을 스캔하고, 썸네일(534 bytes), 프리뷰, Range `0..99/15435`, 폴더 목록, 통계, 미인증 `401`까지 확인합니다. 8899 포트를 쓰며 `SMOKE_PORT`로 바꿀 수 있습니다.
- **Python 워커**는 `release:check`에 포함되지 않습니다. 가상환경과 모델이 필요하기 때문입니다.
  - ASR: `apps/asr-worker/.venv/bin/pytest apps/asr-worker` → `110 passed, 1 skipped` (PR 00 기준선 `aceb0ad`에서 측정, 이후 변경 없음).
  - 장면: `apps/scene-worker/.venv/bin/pytest -q` → `39 passed` (PR 08b, 체크포인트 재개 포함).
- CI(`.github/workflows/ci.yml`)는 `bun install --frozen-lockfile` 후 같은 `bun run release:check`를 돌립니다. 러너 이미지에 ffmpeg가 없어 `packages/media`와 `apps/api`의 실제 ffmpeg 테스트를 위해 설치 스텝 하나를 둡니다.

## 2. 스위트가 증명하는 것

1. **중단·변조 후에도 스캔이 정확하다** (`apps/worker/src/crash-recovery.test.ts`): 1,000개 파일 스캔을 500개에서 중단하고 커서 앞 추가, 커서 횡단 이동, 기존 파일 삭제를 가한 뒤 재개한 결과가 처음부터 스캔한 대조군과 100% 일치합니다(오삭제 0건).
2. **리스 펜싱이 늦은 워커를 막는다** (`packages/database`): 만료된 `lease_epoch`의 완료·체크포인트 저장이 거부되고, 새 에포크만 진행합니다. 체크포인트 저장 중 리스를 잃으면 배치 전체가 롤백됩니다.
3. **백업이 실제로 복원된다** (`v14.test.ts`): `VACUUM INTO` 결과의 `integrity_check`가 `ok`이고, 임시 파일 교체·사이드카 제거를 거친 복원이 원본과 같은 카운트를 냅니다.
4. **색인 재구축이 원자적이다** (`packages/database/src/v26.test.ts`): 재구축 도중 실패하면 색인 내용과 활성 포인터가 함께 이전 상태로 돌아가고, 활성 포인터는 `ready` 행만 가리킬 수 있으며(트리거 6종 거부 경로), GC는 만료된 `superseded`/`failed` 행만 지웁니다.
5. **색인 장애가 검색 전체를 죽이지 않는다** (`packages/database/src/search.test.ts`, `search-fts.test.ts`): trigram 질의가 던지면 LIKE 오라클로 넘어가고, 구조가 깨진 경우에만 핸들을 무장 해제합니다. `SQLITE_BUSY` 한 번으로 재시작까지 LIKE로 떨어지지 않습니다.
6. **대량 이동이 크래시를 견딘다** (`apps/worker/src/move-engine.test.ts`): 게시 후 격리 전 크래시, 다른 바이트가 있는 대상, 검증 후 바뀐 심볼릭 링크 모두 이어서 완료되거나 거부됩니다.
7. **알림이 중복·유실되지 않는다** (`packages/database/src/notifications.test.ts`, `apps/worker/src/observability.test.ts`): 같은 조건은 열린 행 하나로 합쳐지고, 해결된 뒤 새 사건은 새 행이 됩니다. Discord 전송은 1분/5분/15분 재시도 후에도 알림 자체를 잃지 않습니다.
8. **인증 경계가 유지된다** (`apps/api/src/*.test.ts`): 세션 쿠키는 DB 행과 HMAC 다이제스트로만 검증되고, `/api/*`는 인증을 요구하며 `/worker/*`는 별도 토큰을 씁니다. 소유자별 조회가 섞이지 않습니다.

## 3. Win11 실서버(`192.168.0.27`) 라이브 검증

현재 상태: schema `v26`, `14,602` assets(`14,601` active), 라이브러리 3개 모두 `ONLINE`(`d` 14,497, `D 드라이브` 104, `hls-rehearsal` 1), `23,472` transcript segments, `15,327` jobs, `integrity_check ok`, `foreign_key_check` 0, `synchronous FULL`, SQLite `3.54.1`.

- **v25 → v26 배포** (PR 14): 부팅 시 `mode bootstrapped`, `rebuiltMs 97.1`, `verifyMs 89.8`로 기존 색인을 검증해 채택했습니다(재구축 없음). 운영자 재구축 `POST /api/system/search-index/rebuild`는 `201`, 258 ms, build `v11a11stya4tj595`를 만들고 포인터를 옮겼으며 이전 build는 `superseded`가 됐습니다. GC 미리보기는 `{builds:[],total:0}`(30일 보존 내 없음). 헤드리스 Chrome에서 `/diagnostics`의 `검색 색인` 패널이 세 배지와 build 표를 렌더링했습니다.
- **v23 → v25 배포** (PR 12+13 동시): 백업 사본에서 마이그레이션이 5 ms, 13개 테이블 카운트가 전후 동일, `foreign_key_check` 빈 결과. 라이브에서 알림 인박스는 플래그가 꺼져 `404`+`requestId`, 진단 다운로드는 `diagnostics_runs` 행을 남겼습니다.
- **백업**: 배포 전마다 `VACUUM INTO`로 `281,493,504` bytes(`v25`, `68,724` pages, `quick_check ok`)를 만들었습니다. `VACUUM INTO`는 대상 파일이 이미 있으면 실패하므로 타임스탬프 이름을 씁니다.
- **워커 크래시 자동 복구** (2026-11-18, v14): 실행 중인 `mediavault-worker-1`에 `SIGKILL`을 보낸 뒤 5초 만에 새 PID로 재기동, `recovery_logs`(`db_integrity ok`) 기록, 만료 리스 작업이 에포크 2로 재개되어 `13,080`건을 무손실 완료했습니다.
- **헬스**: `/health/live`, `/health/ready` `200`. `/health/ready`는 기본적으로 `dbIntegrity: "skipped"`를 반환하고 `/api/system/status`가 60초 TTL로 `PRAGMA quick_check(1)`을 캐시합니다.
- **드라이브·보안**: `/api/fs/drives`가 `C:\`, `D:\`, `E:\`를 용량과 함께 반환하고, `/api/fs/browse?path=drives/c/Windows`는 `403`으로 차단됩니다.

- **무인 재부팅 리허설**: 2026-11-20 22:57 재부팅. Windows 부팅 `22:57:33` → 슈퍼바이저 `22:58:14` → preflight `22:58:49` → compose 동기화 `22:58:57`, 부팅 84초 뒤 `/health/ready` `200`(맥에서 확인). 사람이 아무것도 하지 않았고, 라이브는 `1.0.0`·`v26`·`14,497` assets였습니다. `AutoAdminLogon=1`이라 콘솔 세션은 자동으로 열리므로 이번 리허설이 증명한 것은 "세션 없음"이 아니라 "사람 개입 없음"입니다. 예약 작업은 `AtStartup` 트리거를 함께 가지므로 S4U 경로는 자동 로그온과 무관합니다.
- **Windows 슈퍼바이저**: 2026-11-20 22:48 관리자 PowerShell에서 `install-service.ps1 -OwnerUser giini`를 실행했습니다. 예약 작업이 `State Running`, `LastTaskResult 267009`(`0x41301`, 실행 중), 5초 뒤 `Preflight passed`, `/health/ready` `200`입니다. 스테이징된 `service-runner.ps1`에 `restart api nginx`, `_common.ps1`에 `Wait-MvTaskState`가 있어 PR 15의 수정이 실제로 도는 코드임을 확인했습니다.

- **정전 복구 리허설**: 2026-11-20 23:08 전원을 끊었다 다시 넣었더니 사람 개입 없이 복구됐습니다. Windows 부팅 `23:08:20` → 슈퍼바이저 `23:08:50` → preflight `23:09:20` → compose 동기화 `23:09:29`, 부팅 69초 뒤 `/health/ready` `200`. 라이브 `1.0.0`·`v26`·`integrity ok`, `level 50/60` 0건. UEFI의 `Restore on AC/Power Loss = Power On`이 실제로 동작함을 확인했습니다.
- **릴리스 백업**: 리허설 직후 `VACUUM INTO`로 `/data/backup-v26-2026-11-20T14-11-17-287Z.db`(`281,583,616` bytes, `quick_check ok`, `user_version 26`)를 만들고 `~/Pmanager-backups/`로 복사했습니다.
- **롤아웃 리허설** (2026-11-21): 라이브를 건드리지 않도록 별도 compose 프로젝트 `mv-rehearsal`(포트 8092, 자체 볼륨, `MEDIA_ROOT=/home/giini/mv-rehearsal-media`)에서 삭제·벌크·HLS를 실제 워커로 돌렸습니다.
  - 삭제 2건이 6개 이벤트를 남기고 `completed`까지 갔고, 격리 파일(`106,167` bytes, SHA-256 `d1b8efd7…`)이 purge 57 ms 전에 존재함을 컨테이너 안에서 확인했습니다.
  - 벌크 8종(tag add/remove, export BOM, poster, reanalyze, move, copy, delete, cancel)이 모두 통과했습니다. held 항목 재시도가 막힌 mutation을 재사용하는 결함을 찾아 `c8fc02a`에서 고치고 회귀 테스트를 추가했습니다.
  - HLS는 워커 재시작을 넘겨 `ready`가 됐고, 소스 변경 뒤 v2가 발행되며 v1 포인터가 해제됐고, 25시간 뒤 GC가 v1만 지웠습니다(구 URL `404`, v2 `200`).
  - 리허설 프로젝트·이미지·픽스처는 모두 제거했고, 라이브는 9개 컨테이너·`1.0.0`·`v26`으로 남았습니다.
- **`D 드라이브` 연결** (2026-11-21 01:18): Windows는 `D:\perfect`에서 107개를 보는데 WSL `readdir`이 65개에서 `EIO`로 멈췄고, 원인은 UTF-8 이름이 287 bytes인 파일 하나였습니다(Linux `NAME_MAX` 255). Windows에서 248 bytes로 줄여 이름을 바꾸자 WSL이 107개를 정상적으로 읽었고, 재스캔이 7.3초에 104개 자산을 색인해 라이브러리가 `ONLINE`이 됐습니다. 앱 변경은 없었습니다.

## 4. 제품 롤아웃 확인 항목 (릴리스 게이트 아님)

기능 플래그를 켜기 전에 남은 항목입니다.

1. `NOTIFICATIONS_ENABLED=1`과 실제 Discord 웹훅으로 알림 1건 전달.
2. ~~라이브 라이브러리에서 캐시 정리 1회~~ 2026-11-21 완료: 미리보기 178개·1,312,617 bytes, 실행 결과 `deletedFiles 178`, `failed 0`, 감사 행 `1fzg0r75a9dfg1x0`.
3. 삭제·벌크: 2026-11-21 리허설로 검증을 마친 뒤 라이브에서 `FILE_MUTATION_ENGINE_ENABLED=1`, `BULK_OPERATIONS_ENABLED=1`로 전환했습니다. `capabilities`가 둘 다 `true`이고, 읽기 전용 export 미리보기 `200`, 없는 자산 삭제 `404`를 확인했습니다.
4. HLS: `HLS_GENERATIONS_ENABLED=1`은 이미 라이브입니다. 리허설에서 생성·재생·supersede·GC를 확인했고, 남은 것은 라이브 라이브러리에서의 실제 사용과 `hls-rehearsal` 픽스처 라이브러리 정리입니다.
