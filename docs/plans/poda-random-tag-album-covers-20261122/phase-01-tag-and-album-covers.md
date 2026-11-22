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

## Status
Planned only. RED, pre-commit Bun commands, provider job details and actual browser E2E not observed yet.
