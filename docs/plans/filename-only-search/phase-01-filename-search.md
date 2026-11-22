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
- implemented: true
- tested: false (unexecuted)
- verified: false (downstream test not run)
- completed: false (verification gate blocked)
- local_test: unavailable (Bun not installed)
- RED observation: not executed (no trusted executor)
- CI dispatch: GitLab pipeline 3098779597 success at implementation SHA 396c8a150c129bc97ced519de6e037359c85d6c7; child 3098779613 **skipped**, `github_actions_request` job 18253380690 **manual**. No external GitHub Actions test/check run was observed.
- E2E: not executed
- Review: pending separate requirements and security/quality lenses

## Static review checkpoint

- Requirements: global search now uses the existing filename filter; image/video thumbnails and full count; one-character and Korean test, wildcard literal behavior, pages, deleted exclusion, auth and AI data unaffected. The manual browser E2E remains unverified.
- Quality/security: no new SQL or interpolation; existing parameterized LIKE and auth middleware reused. Old global endpoint/DTO/encoder removed, scene processing and transcript routes retained. Legacy semantic endpoint consumers outside this repository would break; retained only in this Draft MR.
- Code commit reviewed: `396c8a150c129bc97ced519de6e037359c85d6c7`; reviewed via GitLab diffs and source inspection only, not executable test proof.
- Blocking check: execute real Bun tests/typecheck/build plus GitHub Actions jobs on exact implementation SHA before merge.
