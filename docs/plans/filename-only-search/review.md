# Review evidence for filename-only global search

## Source & commit
- Reviewed GitLab code changes against `main` SHA `59cfa5bf8b81db80e59122bd986cf905158bafbc`.
- Candidate code SHA `396c8a150c129bc97ced519de6e037359c85d6c7`.
- Implementation ref `refactor/filename-only-search`.

## Requirements lens (static source)
- One-character, Korean, ASCII filename filtering from Topbar through SearchPage to AssetGallery and `GET /api/assets?q`.
- Search tile filenames always visible on desktop and touch devices (`showFilenames` forwarded through `AssetGallery` → `JustifiedGrid` → `AssetTile`).
- Existing gallery provides virtualized paged thumbnail results, count, empty/error states and viewer navigation with the query retained.
- Removed global semantic route and corresponding client/DTO; independent scene listing, thumbnail, processing, ASR and embedding remain.
- Added filename/wildcard/deleted/unauthorized/paginated integration tests and negative test proving transcript-only content cannot match.
- Historical performance numbers explicitly identified as past benchmarks.

## Security/quality lens (static source)
- No new DB SQL: existing asset filter binds LIKE query parameters and escapes `%`, `_`, backslash; current authentication preserved.
- No database schema/data deletion and no scene/video processing change.
- Breaking change: external consumers of `/api/search/semantic` will receive 404. Draft MR requires review of any undocumented clients.
- UI filenames shown via JSX text with React escaping; no HTML injection introduced.
- No merge or deploy performed.

## Verification evidence
- GitLab pipeline [3098779597](https://gitlab.com/blond11qq/Pmanager/-/pipelines/3098779597) at `396c8a150c129bc97ced519de6e037359c85d6c7`: **success** for the `dispatch_github_actions` bridge only.
- Child pipeline [3098779613](https://gitlab.com/blond11qq/ci-hub-smoke/-/pipelines/3098779613): **skipped**, child job `github_actions_request` is manual (job 18253380690).
- A real GitHub Actions build/test job for this SHA is **not observed**. There is no runnable Bun local checkout in this session.
- Therefore **Implemented=true, Tested=false, Verified=false, Completed=false**. No TDD RED/GREEN claim.

## Merge blocker
Execute `bun test`, `bun run typecheck`, `bun run --cwd apps/web build`, and the repo's `bun run release:check` in authorized runtime/Actions for exact candidate SHA. Review job logs and verify source SHA. Complete browser smoke: typing a one-character Korean query, matching video/photo files, pagination, open viewer, empty/failed searches, keyboard shortcuts.
