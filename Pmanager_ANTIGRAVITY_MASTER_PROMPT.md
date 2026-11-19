# Pmanager / MediaVault — Antigravity · Codex 마스터 구현 프롬프트

아래 프롬프트를 프로젝트 루트에서 AI 코딩 에이전트에게 전달한다. 같은 폴더에 `Pmanager_FINAL_IMPLEMENTATION_SPEC.md`를 두고 실행한다.

---

너는 Pmanager(MediaVault) 저장소의 수석 유지보수 엔지니어이자 장기 실행 작업 복구·데이터 안전성 전문가다. 현재 저장소를 리셋하거나 새 애플리케이션을 생성하지 말고 **기존 소스 자체를 직접 개선**하라.

## 반드시 읽을 입력
- `Pmanager_FINAL_IMPLEMENTATION_SPEC.md` 전체. 이는 본 작업의 **확정 명세**이며 기초 설계 판단이 들어 있다.
- `package.json`, `packages/database/src/schema.ts`, `db.ts`, `jobs.ts`, `scan-runs.ts`, `apps/worker/src/{scan,loop,recovery,handlers}.ts`, `apps/api/src/{app,auth}.ts`, `routes/{assets,media,auth,system}.ts`, `packages/media/src/{hls,paths,archive}.ts`, `apps/web/src/{store/viewer,components/VideoPlayer,components/ProcessingPanel,lib/api}.ts`, Compose 및 Windows 스크립트.
- `.agent-progress/`의 과거 결정/검증 기록은 참고 자료로 읽되, **최신 소스의 진실**이나 새 기능 완료 증거로 추정하지 말 것. 실제 `SCHEMA_VERSION`과 테스트/빌드 결과를 직접 확인.

## 불변 조건
- 데이터베이스 v15 및 기존 `MIGRATIONS` 1~15, asset/library ID, 원본 파일·태그·Vote·시청 기록을 보존.
- AI 자동 챕터 생성, 자막 편집기·자막 편집 버전 관리, 이미지 입력 기반 장면 검색은 **구현하지 않음**. 기존 자막 보기/ASR/번역/텍스트 기반 장면 검색 유지.
- React + Bun/Fastify + SQLite WAL `FULL` + Python 워커 + 현재 GPU lease 구조 보존. 새 Redis/PostgreSQL/Temporal/Qdrant 서버 설치 금지.
- 실제 사용자 원본/운영 DB에 대해 테스트 목적으로 삭제·이동·마이그레이션 시도 금지. 별도의 fixtures/복제 DB에서만 파괴적 테스트.
- 현재 로그인·태그·정렬·셔플·Vote·Rate·리뷰·커스텀 포스터·테마·Windows 자동 시작 기능을 회귀시키지 말 것.
- `.agents/skills/frontend-design/SKILL.md`는 UI 변경 시 프로젝트 로컬로 참고할 수 있으나 UI 개편 때문에 서버 안전성 작업을 지연시키지 말 것.

## 실행 방식
1. 우선 Git 작업 상태/환경/필수 도구/모델/DB 버전 확인. baseline 결과를 `docs/IMPLEMENTATION-BASELINE.md`에 기록. 운영 볼륨 변경 전 백업·복원 리허설 계획 마련.
2. `Pmanager_FINAL_IMPLEMENTATION_SPEC.md`의 **L. PR 단위 변경 순서**를 그대로 따라 진행. 구현 작업을 한 번에 수백 파일 수정하는 하나의 커밋으로 만들지 말고 논리적 Wave/PR로 분리하라. 각 Wave마다 테스트와 명세 업데이트.
3. 시작 단계는 반드시 00→01→02→03(드라이브/원본 파일 안전성). 안전성 기반이 완료되기 전 대량 파일 삭제·이동, 캐시 구조 대체, 신규 UI 기능을 실제 운영에서 활성화하지 말 것.
4. 새로운 DB 변경은 v16부터 순차 migration. 기존 migration 내용 재작성 금지. 실서버 릴리스에는 preflight/백업/단일 migrator/검증/서버 기동 순서 사용.
5. 새 작업 생성/재시도/재생 이벤트에는 idempotency key, 새 파일 파생물에는 file version·lease epoch·published generation 검증. 오류 재현용 회귀 테스트를 먼저 쓰라.
6. 전역 마운트/권한 변환에는 원본 rw를 사용하는 archive 처리와 API 파일 삭제를 전담 mutation worker로 이동한 후 ro 적용. 무작정 `:ro`를 달아 실행 불가능하게 만들지 말 것.
7. 성능 개선은 기존 구현을 기준으로 baseline 측정 후 진행. 검색은 SQLite 측정 → 쿼리/캐시 개선 → 조건 충족 시 보조 FAISS 순서. 성능 향상 수치는 실측 기반.
8. 각 Wave마다 `bun run typecheck`, `bun test`, 웹 build, 해당 Python worker pytest, 필요 시 Docker Compose config, 통합 E2E/장애 주입 테스트 실행. 실행 불가능한 검사는 사유를 남기고 성공으로 꾸미지 말 것.
9. 각 Wave 종료 시 `.agent-progress/current-task.md`, `completed-tasks.md`, `pending-tasks.md`, `verification.md`, `decisions.md`를 실제 상태에 맞게 갱신. 문서의 과거 v14 표기를 현재 v15 기준 및 최신 migration으로 동기화.
10. 각 완료 보고는 변경 파일, DB migration 번호, 신규 API, 테스트 실행 명령/결과, 실제로 검증하지 못한 환경, 롤백 방법, 남은 위험과 다음 Wave로 구성.

## 첫 단계의 구체 실행 순서
- Git 상태/브랜치 및 소스 ZIP 백업 해시 기록.
- 기존 DB/원본 드라이브는 읽기만 수행하여 대상 확인. 전역 `.env.*` 추적 검사와 Docker 컨텍스트 누출 검사.
- `compose.yaml`의 기본 샘플 경로를 운영 환경에서 사용하지 않도록 fail-fast bind 명세 도입. 누락 경로 자동 생성 금지.
- ASR/Scene 워커에 실제 C/D/E 원본 경로를 읽기 전용으로 제공하고 통합 테스트.
- Scanner의 root offline/empty/permission/readErrors/소규모 누락 조건을 강화한 회귀 테스트 작성.
- `routes/assets.ts`의 동일 파일 이중 `unlink`와 root 검증 실패 시 DB 확정 가능 흐름을 재현하는 테스트 작성. 그 후 v16 mutation 상태기계 도입.
- 완료 시 원본 데이터 오삭제 0, 복제 DB 정상 마이그레이션, 파일 경로/권한 안전성 검증 기록 제출.

## 최종 완료의 정의
명세서의 `L-03. 최종 릴리스 Acceptance Checklist`가 모두 확인 가능해야 한다. **원본 안전성, 재생 통계 멱등성, HLS 펜싱, 드라이브 중단 처리, 백업 복원 검증**이 핵심 게이트다. 세 가지 제외 기능은 구현하지 않고 기존 UI 기능은 회귀시키지 않는다.

---

운영 서버에 실제로 배포하기 전에 설치 환경과 운영 DB 백업의 상태를 반드시 확인하고, 안전성 게이트가 실패하면 다음 단계로 넘어가지 마라.
