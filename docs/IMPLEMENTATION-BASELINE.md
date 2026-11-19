# 구현 기준선 (2026-11-19)

이 문서는 `Pmanager_FINAL_IMPLEMENTATION_SPEC.md`의 PR 00에 해당하는 기준선 기록이다. 이후 모든 PR은 이 기준선과 비교한다.

## 저장소와 입력

| 항목 | 값 |
|---|---|
| 브랜치 | `main` |
| 기준 커밋 | `aceb0ade51f464c94e8f148d6a9da3445e7a6d37` |
| 마스터 프롬프트 SHA-256 | `4a2e8c47f7693dbbb3ede4fcc509ecbd56406bff9ffbefdfcc929271363ab6bc` |
| 구현 명세 SHA-256 | `b58ecf961d63675b86a1db1aded5d09fcd8ff2b6f2fef25f56251310b3493260` |
| 스키마 버전 | `15` (`packages/database/src/schema.ts`) |

## 개발 환경

| 항목 | 값 |
|---|---|
| OS | macOS (Darwin 27.3.0, arm64) |
| Bun | `1.4.3` |
| SQLite (macOS) | `3.54.0` |
| 운영 호스트 | Win11 + WSL2 Ubuntu 24.04, `media-server` (`192.168.0.27`), `~/Pmanager` |
| 호스트 컨테이너 | `api`, `worker`, `web`, `nginx`, `asr-worker` 실행 중 |
| 호스트 SQLite | `3.53.4` (`mediavault-api-1`) |

## 코드 기준선

```bash
bun run typecheck                # exit 0, 6개 워크스페이스
bun test                         # 298 pass, 0 fail, 1137 expect(), 36 files, 7.68s
bun run --cwd apps/web build     # exit 0, 609ms
apps/asr-worker/.venv/bin/pytest apps/asr-worker  # 110 passed, 1 skipped, 17.31s
```

`bun test`는 `packages/{shared,database,media}`와 `apps/{api,worker,web}`의 현재 테스트 전체를 실행한다.

## 데이터 기준선

### 운영 호스트

읽기 전용 연결로 확인했다. 쓰기 작업은 하지 않았다.

| 항목 | 값 |
|---|---|
| `PRAGMA user_version` | `15` |
| 활성 자산 | `12,756` |
| 폴더 | `113` |
| 태그 | `63` |
| 라이브러리 | `1` |
| `playback_progress` 행 | `191` |
| `vote_events` 행 | `1` |
| `PRAGMA integrity_check` | `ok` |
| `PRAGMA foreign_key_check` | 위반 `0` |

### 백업 파일

최신 자동 백업은 `/data/backups/mediavault-2026-11-19T03-25-54-233Z-r777ns.db` (255 MB)이다.

| 항목 | 값 |
|---|---|
| `PRAGMA user_version` | `15` |
| `PRAGMA integrity_check` | `ok` |
| 활성 자산 | `12,756` |
| 폴더 | `113` |
| 태그 | `63` |
| 라이브러리 | `1` |
| `PRAGMA foreign_key_check` | 위반 `0` |

## 복원 리허설

백업을 컨테이너의 `/tmp/restore-rehearsal.db`로 복사한 뒤 읽기 전용으로 열어 검사하고, 임시 파일을 삭제했다. 운영 DB와 백업 원본은 변경하지 않았다.

```bash
docker exec mediavault-api-1 sh -c \
  'cp /data/backups/mediavault-2026-11-19T03-25-54-233Z-r777ns.db /tmp/restore-rehearsal.db'
docker exec mediavault-api-1 bun -e '
  const { Database } = require("bun:sqlite")
  const d = new Database("/tmp/restore-rehearsal.db", { readonly: true })
  console.log(d.query("PRAGMA integrity_check").get())
  console.log(d.query("PRAGMA foreign_key_check").all().length)
  console.log(d.query(`SELECT
    (SELECT COUNT(*) FROM assets WHERE deleted_at IS NULL) assets,
    (SELECT COUNT(*) FROM folders) folders,
    (SELECT COUNT(*) FROM tags) tags,
    (SELECT COUNT(*) FROM libraries) libraries`).get())
'
```

결과는 `integrity_check: ok`, 외래키 위반 `0`, 자산 `12,756`, 폴더 `113`, 태그 `63`, 라이브러리 `1`이다. 임시 복사본은 검사 후 삭제했다.

## 데이터 안전 규칙

이 프로그램은 다음 규칙을 지킨다. 규칙을 어기는 검증은 성공으로 기록하지 않는다.

1. 운영 DB와 원본 미디어에는 파괴적 테스트를 실행하지 않는다. 삭제·이동·마이그레이션 테스트는 `fixtures/`, 임시 디렉터리, 복제 DB에서만 실행한다.
2. 마이그레이션은 복제 DB에서 먼저 적용하고 `integrity_check`, `foreign_key_check`, 자산·폴더·태그·Vote·시청 기록 수를 비교한다.
3. 운영 반영 순서는 `preflight -> pre-migration backup -> 단일 migrator -> verify -> api/worker start`이다.
4. 새 기능은 feature flag로 시작하고, 안전성 수정은 항상 켠다.
5. 삭제·이동은 파일 시스템 변경과 DB 커밋을 하나의 트랜잭션으로 가정하지 않는다. 내구성 있는 작업 로그와 재조정으로 복구한다.
6. 검증하지 못한 항목은 통과로 표시하지 않고 사유를 기록한다.

## 마이그레이션 번호

`PR 02 -> v16`, `PR 03 -> v17`, `PR 04 -> v18`, `PR 05 -> v19`, `PR 06 -> v20` 순으로 적용했다. 명세 I-01이 Auth에 배정한 `v18`은 PR 04가 HLS 테이블을 먼저 가져가면서 `v19`로 밀렸고, 이후 PR도 한 단계씩 올라간다(따라서 Playback은 `v20`). PR 07과 PR 08은 스키마를 바꾸지 않는다. D-04의 공통 `stage_checkpoint`는 PR 08에서 분리해 `v21` 슬라이스로 적용하고, 그 뒤 Duplicates는 `v22`부터 시작한다(결정 32). 각 마이그레이션의 의미와 순서는 `.agent-progress/decisions.md`의 9번, 15번, 32번에 기록한다.

## 롤백 기준

| 상황 | 조치 |
|---|---|
| 마이그레이션 실패 | SQLite 트랜잭션 롤백을 확인하고 이전 바이너리로 되돌린다. DB는 업그레이드 전 백업을 사용한다. |
| 마이그레이션 후 데이터 불일치 | 서비스를 멈추고 업그레이드 전 백업으로 복원한다. 업그레이드 후 원본 파일이 변경됐다면 DB 복원만으로 되돌릴 수 없음을 운영자에게 알린다. |
| 새 기능 오류 | feature flag를 끄고 기존 경로로 되돌린다. 진행 중 작업은 reconciler가 추적한다. |

## 다음 단계

PR 01은 비밀값 ignore, Compose 필수 경로 fail-fast, ASR·Scene 드라이브 마운트, preflight를 다룬다. 이 단계가 통과하기 전에는 파일 삭제·이동 기능을 운영에서 켜지 않는다.
