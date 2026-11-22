# Pmanager UX / media / journal improvements — Alchemy 2.2

Target: `blond11qq/Pmanager`, base `main` @ `8d714bd31639bd5b7d01118f82ede67dd6d50b89`.
Work branch: `feature/media-random-history-journal-https-20261122`.
CI authority: effective `ci_config_path=.gitlab/ci-hub-request.yml@blond11qq/ci-hub-smoke` (GitLab dispatch; provider jobs must be checked separately).

## User-visible scope
1. Random default sort for photos and videos, placed before views.
2. Journal with Notion-like UI, full-feature ambition, and inline image support.
3. HTTPS in place of HTTP.
4. Stable opaque-ID URLs for photos/videos and working browser Back/Forward.
5. Album previous/next keyboard navigation plus Shuffle in album grid view, not enlarged image.
6. Consistent themes.
7. Retain only 5 most recent database backups, delete oldest upon successful new backup.
8. Remove video bookmark feature.

## Phases and dependencies
1. [01-random-sorting](./01-random-sorting.md): 사진 폴더와 동영상(태그 포함)에 랜덤순을 조회수순 왼쪽에 배치하고 기본값으로 설정. 셔플 결과는 화면 내 탐색 중 안정적이어야 함.
2. [02-album-navigation](./02-album-navigation.md): 앨범 페이지에서 이미지 뷰어를 열지 않은 경우 좌·우 화살표로 이웃 앨범 이동, Shuffle 버튼으로 자신을 제외한 임의의 앨범으로 이동.
3. [03-media-history](./03-media-history.md): 모든 사진과 동영상의 ID 기반 고유 URL과 History Back/Forward, 직접 접속, 새로고침, 미존재 ID 처리, 검색/태그/폴더에서 복귀 상태 보존.
4. [04-backup-retention](./04-backup-retention.md): DB 백업은 최신 성공 스냅샷 최대 5개만 유지. 6번째 백업이 정상 검증된 후 가장 오래된 것 정리, 실패하면 기존 정상본 보존.
5. [05-remove-video-bookmarks](./05-remove-video-bookmarks.md): 동영상 UI·대화상자·클라이언트 호출·API 등록에서 북마크 기능 제거. 기존 DB 테이블은 파괴적 마이그레이션 없이 보존.
6. [06-https](./06-https.md): TLS termination with persistent certificate state, reverse proxy, secure cookies, origin/proxy correctness, HTTPS redirect and deployment instructions.
7. [07-theme-parity](./07-theme-parity.md): 기존 light/ash/dark/onyx 각 테마의 모든 페이지, 대화상자, 오버레이, 포커스·호버·선택·에러 색상을 전체 점검.
8. [08-journal-block-editor](./08-journal-block-editor.md): Notion-style block editing, page/database views, rich text, images (secure uploads/storage), tables and properties, block nesting, keyboard UX, searchable pages.

## Delivery rules
- Use `gate_version=2.2` and append evidence only after observing a real result.
- Build/Typecheck/Unit tests from root `package.json`: `bun run typecheck`, `bun test`, `bun run --cwd apps/web build` and release checks.
- No accessible local checkout/runner in this session; remote exact-SHA provider job evidence is required, and a GitLab bridge dispatch is not a test pass.
- No merge, deploy, server change, DNS or certificate provisioning without explicit authorization and real access.
- Notion complete feature parity, global theme perfection and HTTPS for an unknown host must remain **unverified** until a concrete acceptance matrix and environment are available. Do not describe a subset as complete.
