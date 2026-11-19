# Architectural & Tooling Decisions

## Agent Environment & Project-Local UI Skill
- **Runtime:** Google Antigravity CLI/IDE workspace at `/Users/xo/cod/Pmanager`; Bun monorepo (`packages/shared`, `packages/database`, `packages/media`, `apps/api`, `apps/worker`, `apps/web`) plus Python workers (`asr-worker`, `translation-worker`, `embedding-worker`, `scene-worker`).
- **Skill Discovery:** Workspace-local skills under `.agents/skills/<name>/SKILL.md` load with highest priority for this repo only (per `agy-customizations/docs/skills.md`) without affecting other projects.
- **Selected UI Skill:** `anthropics/skills@frontend-design` (`commit 41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f`) installed under `.agents/skills/frontend-design/` for actionable layout/palette/typography/restraint guidance, complemented by Vercel Web Interface Guidelines accessibility rules.

## ChatGPT Second Opinion (`chatgpt-second-opinion`)
- `request_id`: `mediavault-v2-plan-01`
- `status`: `completed` (reviewed and supplied by operator after 180s MCP poll window; verified against container SQLite `3.53.4`, macOS SQLite `3.54.0`, WSL `3.0.5.0`, and native Linux `docker.service` under `systemd`).
- **Adopted Architectural Modifications:**
  1. `PRAGMA synchronous = FULL` + `WAL` + `busy_timeout = 5000` on every connection (DB remains on Linux ext4 `mediavault-data` volume, never DrvFS).
  2. Monotonic `lease_epoch` fencing on `jobs` (`WHERE id = ? AND state = 'running' AND worker_id = ? AND lease_epoch = ? AND lease_expires_at > ?` requiring `changes === 1`) plus `pause_requested`/`cancel_requested` cooperative cancellation and paused dedupe key reservation (`ux_jobs_active`).
  3. Two-stage scan architecture (`scan_runs` + `scan_checkpoints`): resumable non-destructive Stage 1 indexing separated from Stage 2 authoritative complete verification traversal before any `softDeleteMissing`; disconnected/empty root or read errors block deletions (`SCAN_DELETE_FORCE=1` cannot bypass).
  4. Explicit per-drive mounts (`DRIVE_{C,D,E}_ROOT` -> `/media/drives/{c,d,e}`) instead of blanket `/mnt:/media/drives:rw`, plus cross-mount boundary guards and supplemental `(dev, ino)` check without destructive ID merging.
  5. Single-owner Windows boot supervision + separated `/health/live`, `/health/ready`, and per-library storage health so an unplugged drive never crash-loops the server.

## Key Engineering Decisions
1. **Preserve `/media/extra` Mounts:** Live library `npgghj7vxgn4` already stores `root_path = "extra/d"` mapped from `/mnt/e`. Add explicit per-drive `/media/drives/{c,d,e}` mounts as parallel namespaces rather than replacing `/media/extra`, enforce library boundary exclusion when scanning parents, and preserve canonical `libraryId + rootPath` identity.
2. **No Forced Rust Rewrite Before Measurement:** Current `scan.ts` bottleneck is O(N) sequential `stat()` + O(N) per-file `SELECT` + double `readdir()` + unbatched writes. Measure ChatGPT's benchmark matrix across ext4 and DrvFS (`concurrency 1,4,8,16,32`) first; adopt Rust only if Bun CPU/GC dominates over DrvFS/probing.
3. **Host Service Execution Model (Verified Native Docker Engine):** Win11 runs WSL `3.0.5.0` with native `docker.service` enabled inside WSL2 `systemd` (no Docker Desktop volume migration required). Provide one clean boot supervision script/service under the WSL owner identity plus health watchdog.
4. **Windows vs WSL2 SSH:** Enable `ssh.service` inside WSL2 with `authorized_keys` for existing port `22 -> 2222` portproxy, AND provide optional elevated installer support for native Windows `OpenSSH.Server` on an explicit non-conflicting port (`2200`) plus standard Windows OpenSSH documentation.

## Spec v1.0 Program Decisions (2026-11-19)

1. **Sequential PR gate.** PR 00, 01, 02, and 03 land in order before any destructive feature is enabled in production. Each PR commits only after typecheck, the full Bun test suite, the web build, and its own safety checks pass.
2. **Migration numbering follows I-01.** PR 03 ships `v16` with `file_mutations`, `mutation_events`, `library_health`, and the `scan_runs` extensions as one migration. PR 02 therefore computes health from `scan_runs` and live filesystem probes without a new table, so PR 03 keeps the spec's `v16` anchor.
3. **Fixtures only.** All delete, move, quarantine, and migration tests use temporary directories and cloned SQLite files. No test opens the production host DB for writing.
4. **Feature flags start off.** `FILE_MUTATION_ENGINE_ENABLED`, `HLS_GENERATIONS_ENABLED`, `PLAY_EVENTS_ENABLED`, `SERVER_RANDOM_ENABLED`, `SMART_ALBUMS_ENABLED`, `BULK_OPERATIONS_ENABLED`, `SEARCH_FTS_ENABLED`, `SEARCH_FAISS_ENABLED`, and `NOTIFICATIONS_ENABLED` are off by default. Safety preflight and scanner guards are always on.
5. **Compose has no sample fallback in production.** `compose.yaml` requires explicit drive roots and uses `create_host_path: false`. Sample media moves to a dev override.
6. **Backup before migration.** Every schema PR runs its migration on a cloned DB, compares asset, folder, tag, vote, and playback counts, and only then may the host be upgraded with a fresh pre-migration backup.
7. **Compose split.** `compose.yaml` owns only the required `/media` bind. `compose.drives.yaml` owns the optional extra root and the C, D, and E drives, and requires every path. `compose.dev.yaml` is the only place with `./sample-media`. This keeps a single-drive install working without weakening the full host.
8. **Preflight runs in the container view.** The Windows supervisor runs `docker compose run --rm --no-deps --build api bun run scripts/preflight.ts --require-all`. Checking inside the api container verifies the actual bind mounts, not only the host paths.
9. **Migration numbering for PR 02 and PR 03.** PR 02 uses the existing `scan_runs` and live probes so PR 03 can keep the spec's `v16` anchor for `file_mutations`, `mutation_events`, `library_health`, and the `scan_runs` extensions.
