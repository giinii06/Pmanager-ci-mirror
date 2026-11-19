# Pending Tasks

- [x] **Wave 2:** Schema v14 (`PRAGMA synchronous = FULL`, `jobs` monotonic `lease_epoch` fencing + checkpoints + pause/cancel, `scan_runs` + `scan_checkpoints`, `folders` middle-photo cover + `rate`, `vote_events` Orange Weeds, `recovery_logs`, `backup_logs`, `VACUUM INTO` backup/restore, `v14.test.ts` + commit).
- [x] **Wave 3:** Scan baseline benchmark matrix (`scripts/bench-scan.ts`, 1k/10k/50k), 2-stage resumable indexer + authoritative complete verification scanner (`scan.ts`), fenced worker heartbeat/recovery + rotating logs, explicit `/media/drives/{c,d,e}` Host Explorer API (`/api/fs/drives`, `/api/fs/browse`), `/health/live`, `/health/ready`, `/api/system/status`, `/api/backups`, job pause/resume/cancel, crash-recovery & FS/ops release-gate tests + commit.
- [x] **Wave 4:** Frontend UI/UX redesign (`frontend-design` skill + `Dark`/`Light`/`System` zero-flicker theme, search scroll bug fix, remove date grouping, dense true-aspect gallery, photo folder middle thumbnail + Hover/mobile info overlay, custom Safari-safe video player + `Shuffle` next to `Info`, Drive Explorer modal, Vote Orange Weeds, server ops panel) + commit.
- [x] **Wave 5:** Windows 11 single-owner boot-without-login service/watchdog/management scripts (`scripts/windows/`), macOS SSH public-key + `ssh media-server` alias, live host deploy & verification on `192.168.0.27` + commit.
- [x] **Wave 6:** Documentation suite (`docs/{ARCHITECTURE,BENCHMARKS,RECOVERY,WINDOWS-OPERATIONS,MACOS-SSH,TEST-REPORT}.md`), `/no-comments` (`comment-sicko`) + independent `research` audits + fixes across `packages/*`, `apps/*`, `scripts/windows/*.ps1`, full regression test verification, `.agent-progress/` sync, and Wave 6 bundle deploy to `media-server`.

## Operator Follow-ups

- [ ] **Refresh the staged Windows supervisor scripts.** The `MediaVault-Supervisor` task runs `C:\ProgramData\MediaVault\bin\service-runner.ps1`, a staged copy created by an elevated install. That copy predates PR 01 and still lacks `compose.drives.yaml` in its compose arguments. The repo copy under `scripts/windows/` is correct; the staged copy cannot be overwritten without elevation. Run `install-service.ps1` from an elevated PowerShell to refresh it, otherwise a supervisor-triggered restart recreates `api` and `worker` without the drive mounts and takes the library `OFFLINE` until the next manual `up`.

## Spec v1.0 PR Sequence

- [x] **PR 00 Baseline/Backup:** `docs/IMPLEMENTATION-BASELINE.md`, v15 backup verification, restore rehearsal, baseline test counts.
- [x] **PR 01 Ignore/Compose:** `.env*` ignore rules, long-syntax binds with `create_host_path: false`, required drive roots, ASR/scene read-only mounts, preflight script and tests.
- [x] **PR 02 Library Health:** `ONLINE/OFFLINE/DEGRADED/UNVERIFIED` health, scanner finalize guard, small-library deletion policy, health API/UI, zero-deletion regression tests, live v16 migration.
- [ ] **PR 03 Mutation Engine:** `v17` `file_mutations`, `mutation_events`, quarantine delete state machine, idempotent delete API, dedicated mutation worker, SIGKILL reconciliation tests.
- [ ] **PR 04 Cache/HLS:** `v17` `hls_generations`, `hls_active`, immutable generation publishing and routes.
- [ ] **PR 05 Auth:** `v18` Argon2id migration, server sessions, login rate limit, trusted proxy.
- [ ] **PR 06 Playback:** `v19` play sessions and idempotent play events, resume race fix.
- [ ] **PR 07 Viewer/Search UI:** server neighbor cursor, random endpoint, list virtualization.
- [ ] **PR 08 Job Engine:** unified scene queue, GPU ETA, checkpoints, error codes, timeouts.
- [ ] **PR 09 Search:** SQLite profiling, FTS5 fallback, optional FAISS index.
- [ ] **PR 10 Duplicates:** `v21` fingerprints and duplicate review groups, no automatic deletion.
- [ ] **PR 11 Collections:** `v22` smart albums, playlists, bookmarks, poster UX.
- [ ] **PR 12 Bulk/Move:** `v23` dry run, snapshots, per-item operations.
- [ ] **PR 13 Observability:** `v24` health, diagnostics, notifications, cache policy.
- [ ] **PR 14 Search Index Metadata:** `v25` index generations, backfill, GC.
- [ ] **PR 15 Hardening/Release:** docs, CI, Windows boot rehearsal, E2E, performance, release checklist.
