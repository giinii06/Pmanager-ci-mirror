# Pending Tasks

- [x] **Wave 2:** Schema v14 (`PRAGMA synchronous = FULL`, `jobs` monotonic `lease_epoch` fencing + checkpoints + pause/cancel, `scan_runs` + `scan_checkpoints`, `folders` middle-photo cover + `rate`, `vote_events` Orange Weeds, `recovery_logs`, `backup_logs`, `VACUUM INTO` backup/restore, `v14.test.ts` + commit).
- [x] **Wave 3:** Scan baseline benchmark matrix (`scripts/bench-scan.ts`, 1k/10k/50k), 2-stage resumable indexer + authoritative complete verification scanner (`scan.ts`), fenced worker heartbeat/recovery + rotating logs, explicit `/media/drives/{c,d,e}` Host Explorer API (`/api/fs/drives`, `/api/fs/browse`), `/health/live`, `/health/ready`, `/api/system/status`, `/api/backups`, job pause/resume/cancel, crash-recovery & FS/ops release-gate tests + commit.
- [x] **Wave 4:** Frontend UI/UX redesign (`frontend-design` skill + `Dark`/`Light`/`System` zero-flicker theme, search scroll bug fix, remove date grouping, dense true-aspect gallery, photo folder middle thumbnail + Hover/mobile info overlay, custom Safari-safe video player + `Shuffle` next to `Info`, Drive Explorer modal, Vote Orange Weeds, server ops panel) + commit.
- [x] **Wave 5:** Windows 11 single-owner boot-without-login service/watchdog/management scripts (`scripts/windows/`), macOS SSH public-key + `ssh media-server` alias, live host deploy & verification on `192.168.0.27` + commit.
- [x] **Wave 6:** Documentation suite (`docs/{ARCHITECTURE,BENCHMARKS,RECOVERY,WINDOWS-OPERATIONS,MACOS-SSH,TEST-REPORT}.md`), `/no-comments` (`comment-sicko`) + independent `research` audits + fixes across `packages/*`, `apps/*`, `scripts/windows/*.ps1`, full regression test verification, `.agent-progress/` sync, and Wave 6 bundle deploy to `media-server`.

- [ ] **PR 09 post-deploy equality check.** Before the deploy, the live search responses for ten queries were saved as `/tmp/pr09-search-before.jsonl` and `/tmp/pr09-search-before.sha` on `media-server`. After deploying, re-run the same ten queries and compare the response digests; any difference means the FTS path and the oracle disagree on real data.

## Operator Follow-ups

- [ ] **Refresh the staged Windows supervisor scripts.** The `MediaVault-Supervisor` task runs `C:\ProgramData\MediaVault\bin\service-runner.ps1`, a staged copy created by an elevated install. That copy predates PR 01 and still lacks `compose.drives.yaml` in its compose arguments. The repo copy under `scripts/windows/` is correct; the staged copy cannot be overwritten without elevation. Run `install-service.ps1` from an elevated PowerShell to refresh it, otherwise a supervisor-triggered restart recreates `api` and `worker` without the drive mounts and takes the library `OFFLINE` until the next manual `up`.

- [ ] **Turn on the delete engine on the host.** `FILE_MUTATION_ENGINE_ENABLED` is still `0` on `media-server`. Before enabling it, create a throwaway library with fixture files, delete one through the UI, and verify the quarantine file, the `mutation_events` trail, and the cache purge. Never rehearse a delete against a real library asset.

- [ ] **Turn on HLS generations on the host.** `HLS_GENERATIONS_ENABLED` is still `0` on `media-server`. Before enabling it, play a fixture asset with the flag on, confirm a generation row goes `queued -> running -> ready`, that the served playlist uses generation URLs, that the encode survives a worker restart, and that a superseded generation is collected after the grace window.

## Spec v1.0 PR Sequence

- [x] **PR 00 Baseline/Backup:** `docs/IMPLEMENTATION-BASELINE.md`, v15 backup verification, restore rehearsal, baseline test counts.
- [x] **PR 01 Ignore/Compose:** `.env*` ignore rules, long-syntax binds with `create_host_path: false`, required drive roots, ASR/scene read-only mounts, preflight script and tests.
- [x] **PR 02 Library Health:** `ONLINE/OFFLINE/DEGRADED/UNVERIFIED` health, scanner finalize guard, small-library deletion policy, health API/UI, zero-deletion regression tests, live v16 migration.
- [x] **PR 03 Mutation Engine:** `v17` `file_mutations`, `mutation_events`, quarantine delete state machine, idempotent delete API, dedicated mutation worker, SIGKILL reconciliation tests. Deployed as `55e7549`; live schema `v17`, engine off, `12,851` assets intact.
- [x] **PR 04 Cache/HLS:** `v18` `hls_generations`, `hls_active`, immutable generation publishing and routes. Deployed as `deb605c`; live schema `v18`, flag off, `12,851` assets intact, legacy playlist still served.
- [x] **PR 05 Auth:** `v19` Argon2id migration, server sessions, login rate limit, trusted proxy. Deployed as `be9071f`; live schema `v19`, old HMAC cookies rejected, sessions revocable.
- [x] **PR 06 Playback:** `v20` `play_sessions`/`play_events`, per-session contiguous `seq`, idempotent session create, fenced legacy progress, resume state machine, idempotent votes. Deployed as `845d81a`; live schema `v20`, counters unchanged.
- [x] **PR 07 Viewer/Search UI:** `GET /api/assets/:id/neighbor`, `POST /api/assets/random`, viewer session/request guards, removal of the 10k/20k shuffle cap, virtualization retained. `453 pass`; neighbour p95 `12.84 ms` at 12.8k. Deployed as `3881e44`; live schema `v20`, counters unchanged.
- [x] **PR 08 Job Engine:** nine-lane unified queue (scene + mutation included), `runningGpu`/`waitingGpu`, waiting-job ETA, scene sampling coverage, priority aging, 14 stable error codes with environment parking and offline requeue, bounded ffmpeg (wall clock, stall, process group) and bounded scene subprocesses. `470 pass`; deployed `fb8e525` + `9d994c4`; live schema `v20`, counters unchanged. The common `stage_checkpoint` table is split out below (decision 32).
- [x] **PR 08b Stage Checkpoint (`v21`):** common `stage_checkpoints` (jobId/assetId/fileVersion/modelFingerprint/pipelineVersion/stageName/completedUnits/totalUnits/artifactManifest/hash), write → fsync → manifest → DB checkpoint ordering, restart reconciliation, and persisted scene coverage for completed indexes. Deployed as `dede96c`; live schema `v21`, counters unchanged. Duplicates now starts at `v22`.
- [x] **PR 09 Search:** no-schema-change FTS5 trigram candidate generator with the LIKE oracle kept as the answer, bounded per-corpus fan-out, integrity-proof readiness, `RETURNING`-based mutation reporting, `scripts/bench-search.ts` and `scripts/exp-scene.ts`. `499 pass`; live-clone dialogue `1.86 -> 0.09 ms`, scene scan `158 ms` p95. FAISS deferred to PR 14 with the 100k-scene measurements.
- [ ] **PR 10 Duplicates:** `v22` fingerprints and duplicate review groups, no automatic deletion.
- [ ] **PR 11 Collections:** `v23` smart albums, playlists, bookmarks, poster UX.
- [ ] **PR 12 Bulk/Move:** `v24` dry run, snapshots, per-item operations.
- [ ] **PR 13 Observability:** `v25` health, diagnostics, notifications, cache policy.
- [ ] **PR 14 Search Index Metadata:** `v26` index generations, backfill, GC.
- [ ] **PR 15 Hardening/Release:** docs, CI, Windows boot rehearsal, E2E, performance, release checklist.
