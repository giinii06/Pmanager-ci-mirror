# Completed Tasks

## Wave 0 & 1 — Environment Investigation, Backup, Project-Local UI Skill & Progress Tracking
- Audited host Win11 environment (`giini@192.168.0.27`, drives `C:\` 476G / `D:\` 1.9T / `E:\` 932G, WSL `3.0.5.0` `Ubuntu-24.04` with `systemd=true` and native `docker.service` enabled, existing `extra/d` library `npgghj7vxgn4` with 13,080 assets).
- Verified bundled SQLite versions (`3.53.4` inside `mediavault-api-1`, `3.54.0` on macOS, both past `3.51.3` WAL fix) and confirmed `/data` resides on a Linux ext4 Docker volume.
- Created pre-migration SQLite backup via `VACUUM INTO` (`mediavault.db`, 319 MB, `PRAGMA integrity_check = ok`) + `.env*` + `secret.key` in Win11 host `~/Pmanager-backups/pre-v14-*`.
- Audited installed Antigravity customizations (`poteto-mode`, `figure-it-out`, `show-me-your-work`, `agy-customizations`, `benchmark-checklist`) and compared public UI skills.
- Installed `anthropics/skills@frontend-design` (`41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f`) project-locally at `.agents/skills/frontend-design/` with `ORIGIN.json` and read `SKILL.md` in full.
- Completed `chatgpt-second-opinion` (`mediavault-v2-plan-01`) review and incorporated SQLite `synchronous=FULL`, monotonic `lease_epoch` fencing, separated 2-stage scan vs verification reconciliation, explicit `/media/drives/{c,d,e}` mounts, and single-owner boot supervision.
- Created `.agent-progress/` crash-recoverable state docs and `.audit/mediavault-v2.{tsv,todo.md}`.

## Wave 2 — Schema v14, Fenced Job Queue, Middle Covers, Orange Vote Weeds & Verified Backups
- Switched `openDatabase` in `packages/database/src/db.ts` to `PRAGMA synchronous = FULL` alongside WAL + `busy_timeout = 5000`, and added `getSqliteRuntimeInfo`.
- Updated `packages/shared/src/domain.ts` and `packages/database/src/{schema,types}.ts` to `SCHEMA_VERSION = 14`: expanded `jobs` with `worker_id`, `lease_epoch`, `lease_expires_at`, `progress_current`, `progress_total`, `phase`, `checkpoint`, `pause_requested`, `cancel_requested`, `completed_at` and paused dedupe reservation; extended `folders` with `cover_width`, `cover_height`, `cover_poster_version` (with backfill); added `scan_runs`, `scan_checkpoints`, `vote_events`, `recovery_logs`, and `backup_logs`.
- Implemented monotonic `lease_epoch` fencing on `completeJob`, `failJob`, `heartbeatJob`, `saveJobCheckpoint`, `pauseRunningJobWithFence`, `cancelRunningJobWithFence`, and `recoverExpiredJobs` in `packages/database/src/jobs.ts`.
- Implemented filename-ordered middle-photo folder covers (`pickMiddleCover`) and folder percentile `rate` in `packages/database/src/folders.ts`.
- Implemented `vote_events` tracking, idempotent `reconcileVoteEvents`, and `getVoteActivityStats` for Vote-based Orange Weeds in `packages/database/src/contributions.ts`, wired atomically into `voteAsset`, `voteFolder`, and `commitPermanentDelete`.
- Implemented `VACUUM INTO` verified database backup, retention pruning, and restore verification in `packages/database/src/backup.ts`, plus `scan-runs.ts` helpers.
- Verified `bun run typecheck` across all 6 TS packages and `bun test packages/database` (`131 pass, 0 fail`).

## Wave 3 — High-Speed Two-Stage Scanner, Crash-Safe Worker, Drive Explorer & Ops APIs
- Created `scripts/bench-scan.ts` and benchmarked pre/post optimization matrices across 1k, 10k, and 50k synthetic JPEGs (`initialScanMs`: `727ms -> 219ms` at 1k, `6510ms -> 2123ms` at 10k, `10912ms` at 50k; `incrementalScanMs`: `343ms` at 10k, `2990ms` at 50k, linear `0.21–0.22 ms/file` initial / `0.03–0.06 ms/file` incremental; confirming disk/probe I/O dominates over Bun JS CPU).
- Rewrote `apps/worker/src/scan.ts` into a deterministic single-pass `Dirent[]` traversal with 1-query preloaded scan index (`preloadLibraryScanIndex`), bounded async `stat`/probe concurrency (`STAT_CONCURRENCY = 16`, `IMAGE_PROBE_CONCURRENCY = 8`, `VIDEO_PROBE_CONCURRENCY = 4`), `O(1)` `existingMap` updates, 250-item WAL checkpoints, Stage 1 resumable indexing separated from authoritative Stage 2 full verification traversal, and strict mount-boundary (`extra`, `drives/{c,d,e}`, empty root) deletion guards even with `SCAN_DELETE_FORCE=1`.
- Eliminated duplicate `readdir` in `packages/media/src/archive.ts` (`discoverArchiveSetsFromEntries`) and added pre-rename lease + `fileVersion` `canPublish` check in `packages/media/src/thumbnails.ts`.
- Added structured rotating logger (`packages/media/src/logger.ts`, 10MB x 5 rotation + secret/query redaction).
- Added startup & periodic recovery (`apps/worker/src/recovery.ts`), monotonic `lease_epoch` heartbeat/fenced completion/pause/requeue/cancel (`apps/worker/src/loop.ts`, `handlers.ts`).
- Built `/api/fs/drives` & `/api/fs/browse` (`apps/api/src/routes/fs.ts`) with `..`/UNC/symlink/`$RECYCLE.BIN`/`Windows`/`AppData` security guards; updated `apps/api/src/routes/libraries.ts` (`resolveSafeDirectory`, `(dev, ino)` duplicate block, auto-scan enqueue); wired `/health/live`, `/health/ready`, `/api/stats/votes-activity`, `/api/system/status`, `/api/backups`, and `/api/jobs/:id/{pause,resume,cancel}` in `system.ts` & `app.ts`; updated `compose.yaml` (`/media/drives/{c,d,e}`) & `deploy/nginx/default.conf` (`/health/`).
- Added release-gate tests in `apps/worker/src/crash-recovery.test.ts` and `apps/api/src/fs-and-ops.test.ts`; verified `bun run typecheck` (exit 0) and `bun test` (`279 pass, 0 fail` across 34 files).

## Wave 4 — Frontend UI/UX Overhaul (`apps/web`)
- Implemented zero-flicker `Dark` / `Light` / `System` theming with inline pre-paint script (`apps/web/index.html`), semantic light/dark CSS tokens (`apps/web/src/styles.css`), OS `matchMedia` listener (`apps/web/src/store/ui.ts`), and theme controls in `Sidebar.tsx` and `SettingsPage.tsx`.
- Fixed scroll blocking inside `SearchPage.tsx` (`h-full overflow-y-auto overscroll-contain` + sticky header) and `App.tsx` / `FolderPages.tsx`.
- Removed Year/Month section headers everywhere by default (`groupByMonth === true` opt-in), tightened gallery density (`GAP = 3`), eliminated cropping via `object-contain`, fixed aspect distortion on clamped/partial rows (`justified.ts` + `justified.test.ts`), and prioritized loading for visible top rows (`index < 16`).
- Redesigned photo folder cards (`FolderCard.tsx` + `FolderPages.tsx`) to use server-computed filename-ordered middle covers with true aspect ratio (`coverWidth` / `coverHeight`) inside a masonry grid, clean default framing, and hover/mobile `정보` overlay showing folder name, photo count, total Votes, Rate (%), and view count.
- Rewrote `VideoPlayer.tsx` to drop native `controls` (eliminating Safari duplicate fullscreen controls) in favor of custom auto-hiding controls with single fullscreen button, clean caption offset, and full decoder cleanup on unmount/source change; moved `Shuffle` button directly adjacent to `정보` in `WatchPage.tsx`.
- Built `HostFolderPicker.tsx` (Win11 drive explorer for `C:\`, `D:\`, `E:\` with breadcrumbs, back/forward/up, search, `이 폴더 지정`) and integrated into Library Add Dialog (`SettingsPage.tsx`).
- Added Vote-based **Orange Weeds (`주황색 잡초`)** `ActivityCalendar` alongside green contributions, Server Status & Auto-Recovery & Manual `VACUUM INTO` Backup management in `SettingsPage.tsx`, and Job Pause/Resume/Cancel controls in `ProcessingPanel.tsx`.
- Verified `bun run typecheck` (exit 0), `bun test apps/web` (`21 pass, 0 fail`), and `bun run --cwd apps/web build` (exit 0, `244ms`).
