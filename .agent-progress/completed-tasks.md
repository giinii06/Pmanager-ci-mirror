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
