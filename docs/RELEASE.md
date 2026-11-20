# 릴리스 체크리스트

이 문서는 MediaVault를 릴리스하거나 호스트에 배포할 때 거치는 게이트를 순서대로 정리합니다.
자동 게이트는 명령 하나로 끝나고, 사람이 직접 해야 하는 게이트는 3장과 4장에 있습니다.
자동 게이트가 통과해도 3장을 건너뛴 배포는 없습니다.

## 1. 자동 게이트

```bash
bun install --frozen-lockfile
bun run release:check
```

`release:check`는 아래를 순서대로 실행하고, 하나라도 실패하면 거기서 멈춥니다.

| 게이트 | 확인하는 것 |
| --- | --- |
| version | `packages/shared/src/constants.ts`의 `APP_VERSION`과 루트 `package.json`의 `version`이 같다 |
| typecheck | 6개 워크스페이스와 루트 프로젝트의 타입 검사 |
| tests | `bun test` 전체 |
| build | `apps/web`의 Vite 프로덕션 빌드 |
| smoke | 실제 API와 워커를 띄워 계정 생성, 라이브러리 등록, 스캔, 썸네일, Range 스트리밍, 폴더, 통계를 HTTP로 확인 |

`.github/workflows/ci.yml`이 `main` 푸시, 풀 리퀘스트, 수동 실행에서 같은 명령을 돌립니다.
워크플로에 명령을 따로 적지 않습니다. 게이트 정의는 스크립트 하나입니다.

`smoke`는 8899 포트를 씁니다. 이미 사용 중이면 `SMOKE_PORT=8901 bun run smoke`로 바꿉니다.

변경한 영역에 따라 아래를 추가로 돌립니다.

- **ASR**: `apps/asr-worker/.venv/bin/pytest apps/asr-worker`. Python 가상환경과 모델이 필요해 CI에서는 돌리지 않습니다.
- **미디어 루트**: `bun run preflight -- --paths=<roots> --require-all --min-free-mb=1024`. 호스트에서만 의미가 있습니다.
- **검색 성능**: `bun run scripts/bench-search.ts run <db>`. 호스트 클론에서 재고 `docs/BENCHMARKS.md`와 비교합니다.

## 2. 호스트 배포

1. **백업한다.** `openDatabase()`는 연결할 때 마이그레이션을 적용하고 백업을 만들지 않습니다. 백업 없는 마이그레이션은 없습니다.
   ```bash
   # api 컨테이너 안에서
   bun -e 'import { Database } from "bun:sqlite"; const d = new Database("/data/mediavault.db", { readonly: true }); console.log(d.query("PRAGMA quick_check").get(), d.query("PRAGMA user_version").get()); new Database("/data/mediavault.db").exec(`VACUUM INTO "/data/backup-<version>.db"`)'
   docker cp mediavault-api-1:/data/backup-<version>.db ~/Pmanager-backups/
   ```
   복사본의 `quick_check`와 `user_version`을 다시 읽고, `-wal`/`-shm` 없이 단일 파일인지 확인합니다.

2. **커밋을 옮긴다.** 호스트 체크아웃에는 GitHub 자격 증명이 없습니다. Mac에서 번들을 만들어 `scp`하고 fast-forward합니다.
   ```bash
   git bundle create /tmp/pmanager-<sha>.bundle <old-sha>..main
   scp /tmp/pmanager-<sha>.bundle giini@<host>:/tmp/
   ssh giini@<host> 'cd ~/Pmanager && git fetch /tmp/pmanager-<sha>.bundle main && git merge --ff-only FETCH_HEAD'
   ```

3. **바뀐 서비스만 다시 만든다.** env 파일 5개와 compose 파일 11개를 모두 넘깁니다.
   ```bash
   docker compose --env-file .env --env-file .env.asr --env-file .env.translation \
     --env-file .env.embedding --env-file .env.scene \
     -f compose.yaml -f compose.drives.yaml -f compose.asr.models.yaml -f compose.asr.cuda.yaml \
     -f compose.translation.models.yaml -f compose.translation.cuda.yaml \
     -f compose.embedding.models.yaml -f compose.embedding.cuda.yaml \
     -f compose.gpu.yaml -f compose.scene.models.yaml -f compose.scene.cuda.yaml \
     build <services>
   # 이어서 --no-deps로 하나씩 up -d, api는 healthy를 기다린 뒤 다음 서비스
   ```
   `web`을 다시 만들었으면 반드시 `nginx`를 재시작합니다.

4. **확인한다.** 최소한 아래를 본다.
   - `PRAGMA user_version`이 기대값이고 `PRAGMA integrity_check`가 `ok`
   - `/health/ready` 200
   - `/api/system/diagnostics` 200, 이번 변경이 추가한 섹션이 보임
   - 이번 변경의 기능 라우트를 세션 쿠키로 한 번 호출
   - 재시작 후 15분간 API 로그에 `level 50`/`60`이 없음

5. **기록한다.** `.agent-progress/verification.md`에 백업 크기, 마이그레이션 결과, 라이브 수치, 확인하지 못한 항목을 남깁니다.

## 3. Windows 무인 부팅 리허설

정전 후 로그인 없이 스택이 돌아오는지 확인하는 게이트입니다. SSH로 대신할 수 없고, 호스트 앞에서 관리자 권한으로 한 번 수행합니다.
절차는 `docs/WINDOWS-OPERATIONS.md`에 있습니다. 요약하면 아래 순서입니다.

1. 관리자 PowerShell에서 `install-service.ps1 -OwnerUser giini`를 실행하고 `State: Running`과 경고 없음을 확인합니다.
2. `status-server.ps1`과 `check-health.ps1`이 정상인지 확인합니다.
3. UEFI에서 `Restore on AC/Power Loss`를 `Power On`으로 둡니다.
4. 로그인하지 않고 재부팅하고 3분 뒤 다른 PC에서 `/health/ready`가 200인지 확인합니다.
5. 전원을 뽑았다가 다시 넣고 같은 확인을 반복합니다.

`scripts/windows/*.ps1`을 고쳤다면 예약 작업이 `C:\ProgramData\MediaVault\bin`의 스테이징된 복사본을 실행하므로 `install-service.ps1`을 다시 실행해야 합니다.

## 4. 릴리스 판정

- [x] `bun run release:check` 통과
- [x] 백업 생성과 무결성 확인
- [x] 호스트 배포 후 확인 항목 통과
- [x] Windows 무인 부팅 리허설 결과 기록 (날짜, 재부팅/정전 각 1회)
- [x] 기능 플래그의 현재 값과 이유 기록
- [x] `README.md`, `docs/ARCHITECTURE.md`, `docs/TEST-REPORT.md`가 현재 스키마와 수치를 말함
- [x] 롤백 경로 확인

## 5. 롤백

- **코드**: 이전 커밋으로 체크아웃하고 같은 compose 명령으로 다시 빌드한 뒤 `up -d --no-deps`로 바꿉니다.
- **DB**: 마이그레이션이 가산적이면 이전 바이너리가 더 새로운 `user_version`을 만나도 `openDatabase()`가 즉시 반환하므로 새 테이블을 무시하고 동작합니다. 마이그레이션이 의미나 데이터를 바꿨다면 2장 1단계의 백업을 복원합니다. 복원 전에 `api`와 `worker`를 멈춥니다.
- **Windows**: `stop-server.ps1` → 이전 커밋 체크아웃 → `start-server.ps1`.

## 6. 배포 후 15분

`/health/ready`, `/api/system/status`, API와 워커 로그의 `level 50`/`60`, 그리고 사용자가 실제로 여는 경로 하나(갤러리, 재생, 검색)를 확인합니다.
경고가 반복되면 5장의 롤백을 먼저 판단하고, 원인 조사는 그다음입니다.
