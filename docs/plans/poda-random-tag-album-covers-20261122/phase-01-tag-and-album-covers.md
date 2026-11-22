# Phase 01 — Tag overview sorting, rotating covers and remove manual pin control

## Plan
1. Add tests for the five tag overview modes, stable seeded random order, empty/tied rankings, and PhotoTag vs VideoTag stats/cover eligibility.
2. Add aggregated view/vote counters to `packages/database/src/tags.ts` records and `@mediavault/shared` TagSummaryDTO, API DTO conversion; choose each tag cover with SQL `ROW_NUMBER() ... ORDER BY RANDOM()`. Isolate photo/video tag joins.
3. Add `apps/web/src/lib/tagSort.ts` pure helper and wire five buttons into `apps/web/src/pages/GalleryPages.tsx` for tag-overview only. Fresh per-mount query key bypasses React Query cache for covers, while keeping a stable displayed selection during re-renders.
4. Add `randomizeFolderCovers(db, folders)` in DB domain using bounded parameter batches and one randomly ranked image per populated folder, and use it only at `GET /api/folders` response boundary. No mutation of pinned-cover state.
5. Remove cover pin button, mutation, helper and no-longer-applicable tests from photo viewer. Keep legacy PUT route and migration data intact for compatibility.
6. Execute `bun test`, `bun run typecheck`, and `bun run --cwd apps/web build` if Bun executable is present. Inspect source diffs and dispatched GitHub Actions jobs at candidate SHA; verify navigation and refresh behavior in an authenticated browser when available.
7. Commit code on the resumed branch, request GitLab external CI without changing provider, self-review the actual diff in two lenses, append checkpoint evidence. Leave Draft MR unmerged and app undeployed.

## Failure/negative cases
- Empty tags and albums must not fetch a missing cover; fallback remains.
- A photo tag must not get a video thumbnail (nor the reverse).
- Album random covers must not leak deleted assets or choose from a different folder.
- Viewer no longer has left/right or single-image pin action, and existing swipe/navigation still works.
- Tag sorting must not mutate the underlying cached data or cause refetch on each click.
- Dynamic random selection must never rewrite pinned_cover_asset_id or rename Docker volumes/DB.
- Sparse or large album lists should not create a per-card query; cap SQL placeholders at 400.

## Execution evidence / blocker
- Tests-first commit: `a1b8b4929586210d38e89c6e0438ccaa928e5323`; test-only RED behavior was **not executed**, no verified TDD RED result.
- User-visible code: `ce087d7c10833f91fa29454391ea48367b01d99c`, followed by tag-overview re-entry fix at **candidate code SHA `dc355768bd517f237ee3e57ee4e87586e55e2e93`**.
- API and DB: `listTags` now samples a new eligible cover on query and sums matching media views/votes; `GET /api/folders` applies batch-limited, read-only random cover overrides. The persisted album pin and legacy endpoint remain unchanged.
- Frontend: five tag overview sort buttons in the supplied order, default seeded random; per-mount/refocus navigation overview seed; photo viewer pin button plus no-longer-used frontend helper and tests removed.
- SQL dry-run with isolated in-memory Python `sqlite3`: correlated sums and randomized window-cover query produced valid eligible results. This is **not** full Bun application testing.
- Build / typecheck / Bun tests / browser E2E: **not executed in this session** (no Bun checkout/executable or production browser).
- Effective GitLab CI config dispatches GitHub Actions. Pipeline **3099032604** at exact candidate SHA reported GitHub Actions **failed** via provider status, run https://github.com/giinii06/Pmanager-ci-mirror/actions/runs/44992687882 . No job logs or checkout evidence available; root cause unproven. GitLab dispatcher itself succeeded.
- **Blocked/unverified.** Never infer code defect from external callback alone. No merge, deployment or remote settings changes.


## Subsequent CI diagnostic run (no source modification)
- GitLab pipeline **3099047910**, branch HEAD `ef3498c4b08fb9f8a12c868a8fa17cef9d006196` (documentation-only commits after code SHA `dc355768bd517f237ee3e57ee4e87586e55e2e93`). Dispatch succeeded, GitHub provider returned **failed**: https://github.com/giinii06/Pmanager-ci-mirror/actions/runs/44993554908 . No logs/checkout SHA available.
- Original failing provider run: https://github.com/giinii06/Pmanager-ci-mirror/actions/runs/44992687882 . Same feature source code; repeat failure means transient-job hypothesis was not supported, but root cause still unknown.
- Limited local checks: exact tagSort implementation transcribed into isolated TypeScript module, compiled with global `tsc` and six Node assertions passed; tag and album SQL shapes reproduced in Python stdlib sqlite3 with 30 trials each. Neither is the repository's Bun test/typecheck/build or actual E2E.
- Full Bun executable/repository checkout unavailable in this container; GitLab bridge supplies no GitHub job traces; direct GitHub URLs inaccessible here. Do not change runtime code or CI provider on unobserved assumptions.


## Diagnosis and repair checkpoint (2026-11-22)
- The user supplied the real `gh run view 44993554908 -R giinii06/Pmanager-ci-mirror --log-failed` trace. The checked-out SHA was `ef3498c4b08fb9f8a12c868a8fa17cef9d006196` (matching bridge input), Bun setup and `bun install` succeeded.
- Observed first failure: `src/random-covers.test.ts(77,45): error TS2769` during `bun run --cwd packages/database typecheck`. Assertion `expect(['photo1','photo2']).toContain(photo.coverAssetId)` passed `string | null` to a `string` parameter. Tests and build did **not** run in that failing job because of TypeScript error.
- Minimal repair committed as **code SHA `b1772b2342e5cf128eafb0354322aad8677569db`**: `expect(['photo1','photo2']).toContain(photo.coverAssetId ?? '')`. This preserves the assertion that null is not an acceptable cover, but satisfies the TypeScript expected string type. No production implementation changed.
- [GitLab pipeline 3099052889](https://gitlab.com/blond11qq/Pmanager/-/pipelines/3099052889) ran for exactly `b1772b2342e5cf128eafb0354322aad8677569db`: dispatch `success`, GitHub callback `github-actions/ci-hub-request: success` on [GitHub Actions run 44993844861](https://github.com/giinii06/Pmanager-ci-mirror/actions/runs/44993844861) at 2026-11-22T06:29:36.950Z.
- GitHub job command-by-command logs for the successful run were *not* independently retrieved. No direct authenticated browser user-flow E2E. Therefore the provider reports **success**, but `jobs_verified=false`, `e2e_verified=false`; do **not** claim verified/completed.
- Review: one-line test-only change has no DB or API impact; keeps intended test behavior. `main` unchanged, Draft MR retained, no deployment.
