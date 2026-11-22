# Phase 01 — implement four UI behaviors (integrated slice)

State: not_started. Gate version 2.2. No tests or implementation evidenced at plan creation.

## Files & steps
1. `apps/web/src/components/AppShell.tsx`, `Sidebar.tsx`, `Topbar.tsx`, `store/ui.ts`: render 0-width persistent collapse, temporary 3-second edge-hover overlay, manual reopen and responsive mobile fallback. Add contract tests covering persistent toggle and transient behavior as executable tests allow.
2. `packages/database/src/archives.ts`, `apps/web/src/pages/SettingsPage.tsx`, and database tests: cap rendered list at five; prune oldest terminal jobs without removing queued/extracting/converting rows. Run existing archive worker integration tests to guard against orphaned jobs; verify stable ordering, zero/one/five/six entries, reprocessing a pruned signature.
3. `apps/web/src/components/AssetGallery.tsx`, `JustifiedGrid.tsx`, `AssetTile.tsx`, `pages/GalleryPages.tsx` and layout tests: photo-like aspect-preserving video row tiles, enlarged target height for video, video-tag cover natural ratio, no hover darkening on photo/video/tag while retaining previews/metadata/focus.
4. `apps/web/src/components/WatchPage.tsx`, `AlbumDeleteDialog.tsx` or equivalent controlled action: delete immediately on click without confirm overlay, API completion/queue feedback, busy prevention; capture poster from current video time with precise ms validation, no modal. Remove stale imports/state/UI.
5. Inspect diff for unintentional changes. Run `bun test`, `bun run typecheck`, `bun run --cwd apps/web build` when executor available, else record unavailable (never call it passed). Commit candidate SHA and inspect exact-SHA provider evidence.

## Negative cases
- Rapid hover, timer expiry, manual reopen during peek, mobile pointer and route navigation.
- Old archive rows >5 when all terminal; active archives must remain addressable by the worker; no deletion of extracted media; two simultaneous prune calls.
- Portrait video thumbnails and unknown dimensions, photo tiles, keyboard/focus access; hover must not dim imagery.
- Duplicate delete clicks, server-rejected offline source, unavailable player duration, poster captured at end-of-file, capture failure and cache update.

## Rollback
Revert code commit from this review branch; DB pruning is deliberately non-reversible for old completed/failed **history rows only**, never file system content. Do not merge/deploy before approved acceptance.

## Code checkpoint / unverified status — 2026-11-22
- Implemented code at `631bc57dff2ad9c3f445ece8aadedcb799d85022`. Files: AppShell/Sidebar/Topbar, AssetGallery/JustifiedGrid/AssetTile/GalleryPages/FolderCard, WatchPage/AlbumDeleteDialog/posterFrame, database archives/tags, shared/API cover width+height, SettingsPage.
- Unit tests authored: `packages/database/src/archive-retention.test.ts`, `apps/web/src/lib/posterFrame.test.ts`. **RED not executed, GREEN not executed, build/typecheck not executed** (no Bun executor). TDD cycle not proven; no waiver claimed.
- Effective CI path external GitHub Actions request through GitLab pipeline `3098891915` bound to `631bc57dff2ad9c3f445ece8aadedcb799d85022`. Observed GitLab `dispatch_github_actions=success` and zero GitLab test jobs; provider job execution and E2E **unknown**, not passing.
- Self-review: requirements lens and code/security lens on the same code SHA, see `review.md`. No independent review or browser fixture.
- State: **blocked**. Do not merge or deploy.
