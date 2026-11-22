# Phase 01 — Complete filename-only search vertical slice

**Type:** user-visible integration phase (not an internal-only foundation)

## Entry and behavior

`Topbar` submits `/search?q`; `SearchPage` renders `AssetGallery`; `api.assets` requests authenticated `/api/assets?q`; SQL matches the filename column; results open via the existing viewer.

## Files and steps

1. RED test: extend `apps/api/src/navigation.test.ts` to assert filename-only result, deleted/missing matches, literal metacharacters, and legacy semantic route returning 404. Run `bun test apps/api/src/navigation.test.ts` before code if a trusted Bun executor exists; expect legacy route assertion to fail.
2. GREEN: replace `apps/web/src/pages/SearchPage.tsx` semantic hit list with shared `AssetGallery`, using q and latest sort. Handle blank queries before the gallery API is invoked.
3. Revise `apps/web/src/components/Topbar.tsx` text/accessible label and allow one-character debounce. Preserve Cmd/Ctrl+K, Enter and Escape.
4. Remove `api.semanticSearch` and its sole client type import in `apps/web/src/lib/api.ts`.
5. Retire `/api/search/semantic`, rank fusion and their helpers in `apps/api/src/routes/scenes.ts`, retaining scene listing, scene generation and scene thumbnail routes. Remove now-unused global semantic DTO definitions from `packages/shared/src/domain.ts`.
6. Retire global-semantic-only tests in `apps/api/src/scenes.test.ts`, add filename-vs-dialogue integration regression while preserving scene processing tests; delete orphaned `apps/api/src/scene-query.ts`. Update historic benchmark documentation without rewriting past measurements.
7. Update the search-specific layout assertion in `apps/web/src/components/ui/designSystem.test.tsx` to verify gallery reuse instead of the old inline thumbnail.
8. GREEN verification: `bun test apps/api/src/navigation.test.ts apps/web/src/components/ui/designSystem.test.tsx`; repo regressions: `bun test`; `bun run typecheck`; `bun run --cwd apps/web build`; `bun run release:check`. Treat unexecuted checks as unknown, never green.
9. Commit candidate SHA, dispatch effective GitLab->GitHub CI, inspect exact-SHA status and actual provider jobs, review requirements and quality/security; record state checkpoint.
10. Open Draft MR without merge/deploy. Final user-flow manual browser E2E remains required if no browser fixture is available.

## Risk / rollback

Risk: legacy consumers of `/api/search/semantic` break. This endpoint is only consumed by the existing SearchPage in the pinned repo. The feature branch is isolated; revert the candidate commit or decline MR for rollback. No schema/data deletion occurs.

## Gate record

- gate_version: 2.2
- implemented: false
- tested: false
- verified: false
- completed: false
- local_test: unavailable (Bun not installed)
- RED observation: not executed (no trusted executor)
- CI provider: external GitHub Actions via effective GitLab configuration; unchecked
- E2E: not executed
- Review: pending separate requirements and security/quality lenses
