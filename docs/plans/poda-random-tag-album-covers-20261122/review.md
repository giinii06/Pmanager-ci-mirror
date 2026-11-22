# Two-lens SELF review — tag sorting and randomized thumbnail display

**Project:** `blond11qq/Pmanager`, branch `feature/poda-branding-20261122`, Draft MR !19.
**Reviewed source head:** `dc355768bd517f237ee3e57ee4e87586e55e2e93`, base before this task `f07b05e2ec52bbb06c40cd7e839c8566c351547e`.
**Reviewer:** sequential self-review only; not independent.

## Requirements lens
- **Implemented (source only):** `GalleryPages.tsx` shows the exact five buttons on both tag overview routes: 랜덤순 / 조회수순 / Vote순 / 이름순 / 날짜순; initial `tagSort='random'`. Tag-detail asset sorting remains independently controlled.
- **Implemented (source only):** `tagSort.ts` sorts on summed media views/votes, name or tag creation date, and Fisher–Yates randomization seeded per overview visit without mutating cached arrays.
- **Implemented (source only):** `listTags` selects one random eligible asset using SQL `ROW_NUMBER() OVER(PARTITION ... ORDER BY RANDOM())`; photo/video joins enforce kind and exclude deleted items. React Query new overview visit seed avoids a stale tag-cover cache on reopening, including detail->overview navigation where route components are reused.
- **Implemented (source only):** `randomizeFolderCovers` on folder-list API selects a single eligible nondeleted *direct* image per album in SQL batches up to 400, leaving database pinned-cover state and other endpoints intact.
- **Implemented (source only):** single and left/right “썸네일로” controls, associated UI mutation and dead cover-action helper/tests removed; tag editing and media viewer operations remain.
- **New tests authored:** `tagSort.test.ts`, `random-covers.test.ts`; adjusted `videoTagLayout.test.ts`. Tests **not executed**. Random selection can return the same asset on successive reloads by chance (and necessarily does for one item).
- **Missing external proof:** actual browser routes, all responsive themes, refresh/revisit behavior, performance benchmarks, and end-to-end acceptance **not verified**.

## Quality/security lens
- No mass update to SQLite albums or cover pin columns; no schema, auth, session, filesystem mutation or data deletion by this change.
- Tag aggregation filters out deleted assets and separates photo/video kinds; SQL uses whitelisted names from fixed `AssetKind`, never user-supplied table names.
- Folder random-cover SQL uses parameterized IDs in batches (400 max), not an N+1 per-card request; cover ID/dimensions/version all from the same selected row.
- Existing manual `PUT /api/folders/:id/cover` endpoint is retained for backwards compatibility; **only UI entry point is removed**. Old pins are ignored on the folder-list read override but untouched in persisted DB.
- Risks: thumbnail changes after a refetch/sort are permitted; duplicate random outcomes possible. Existing server-based pinned metadata and UI random display differ intentionally.
- CI evidence at exact code SHA: GitLab pipeline 3099032604 dispatch success, external GitHub Actions callback **failed**; job logs could not be accessed through connected GitLab/web and failure root cause is **unknown**. No speculative source patches.

## Verdict
**Code implemented, tests/E2E unverified; external CI failed with no accessible job-level reason.** Stop at implemented/blocked. Preserve Draft MR, do not merge or deploy until the failing run and exact checkout/job logs are inspected and required tests pass.
