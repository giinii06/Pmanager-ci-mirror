# Verification Ledger

## Pre-Wave-2 Baseline State (`763c1be`)
- `bun run typecheck`: exit 0 across 6 TS packages.
- `bun test packages/database`: 126 pass, 0 fail (13 files).
- `bun test apps/api`: 76 pass, 0 fail (8 files).
- Prior `c712ac3` full checks: `bun test` 265 pass, 0 fail (31 files); `apps/web` `vite build` 317ms (`2948` modules); `asr-worker` `pytest` 110 passed, 1 skipped.
- Bundled SQLite version check: `3.54.0` (macOS), `3.53.4` (`mediavault-api-1` Linux container; past `3.51.3` WAL fix).
- Live Win11 host backup before Schema v14: `VACUUM INTO mediavault.db` (`319M`), `PRAGMA integrity_check = ok`, `13,080` active assets (`12,565` images, `515` videos, `113` folders, `3` views).

## Wave 2 Checkpoint (`Schema v14 + DB`)
- `bun run typecheck`: exit 0 across all 6 workspaces (`shared`, `database`, `media`, `api`, `worker`, `web`).
- `bun test packages/database`: `131 pass, 0 fail` across 14 files (`477 expect() calls`, `834ms`), including `v14.test.ts` verifying `synchronous = FULL`, monotonic `lease_epoch` fencing, pause/cancel/recovery dedupe preservation, filename middle-photo covers, folder `rate`, idempotent `vote_events` Orange Weeds separation, and `VACUUM INTO` backup + restore roundtrip.

## Wave 3 Pre-Optimization Scan Baseline (`scripts/bench-scan.ts`, macOS APFS)
- **1,000 synthetic JPEG files:** `enumMs: 2`, `statMatrix {1:13, 4:4, 8:4, 16:2, 32:2}`, `probeMatrix1kSubset {1:394, 4:179, 8:179, 16:183, 32:156}`, `dbUnbatched1kMs: 139`, `dbBatched250Ms: 5`, `initialScanMs: 727` (`0.73 ms/file`), `incrementalScanMs: 39` (`0.04 ms/file`), `rssMb: 75.4`.
- **10,000 synthetic JPEG files:** `enumMs: 8`, `statMatrix {1:117, 4:39, 8:36, 16:20, 32:14}`, `probeMatrix1kSubset {1:355, 4:167, 8:165, 16:153, 32:155}`, `dbUnbatched1kMs: 128`, `dbBatched250Ms: 82` (10k batched), `initialScanMs: 6510` (`0.65 ms/file`), `incrementalScanMs: 377` (`0.04 ms/file`), `rssMb: 97.5`.

## Wave 3 Post-Optimization Benchmarks & Release-Gate Verification (`macOS APFS`)
- **1,000 synthetic JPEG files (`scripts/bench-scan.ts --count=1000`):** `enumMs: 2`, `dbUnbatched1kMs: 151`, `dbBatched250Ms: 6`, `initialScanMs: 219` (`0.22 ms/file`, 3.32x faster), `incrementalScanMs: 38` (`0.04 ms/file`), `rssMb: 90.9`.
- **10,000 synthetic JPEG files (`scripts/bench-scan.ts --count=10000`):** `enumMs: 9`, `statMatrix {1:130, 4:40, 8:33, 16:19, 32:20}`, `dbBatched250Ms: 81`, `initialScanMs: 2123` (`0.21 ms/file`, 3.07x faster), `incrementalScanMs: 343` (`0.03 ms/file`), `rssMb: 141.8`.
- **50,000 synthetic JPEG files (`scripts/bench-scan.ts --count=50000`):** `enumMs: 30`, `statMatrix {1:590, 4:189, 8:117, 16:93, 32:67}`, `dbBatched250Ms: 424`, `initialScanMs: 10912` (`0.22 ms/file`), `incrementalScanMs: 2990` (`0.06 ms/file`), `rssMb: 285.1`.
- `bun run typecheck`: exit 0 across all 6 TS packages (`shared`, `database`, `media`, `api`, `worker`, `web`).
- `bun test`: **`279 pass, 0 fail`** (`1039 expect() calls`, 34 files, `9.45s`), including 5 new tests in `apps/worker/src/crash-recovery.test.ts` (1,000-file interrupted scan across add/move/delete vs fresh baseline, stale `.tmp` cleanup & `lease_epoch` thumbnail fencing, `paused` preservation, empty mountpoint guard ignoring `SCAN_DELETE_FORCE=true`, `VACUUM INTO` backup/restore) and 4 new test groups in `apps/api/src/fs-and-ops.test.ts`.

## Wave 4 Checkpoint (`apps/web` UI/UX Overhaul)
- `bun run typecheck`: exit 0 across all 6 TS packages.
- `bun test apps/web`: **`21 pass, 0 fail`** (`57 expect() calls`, `justified.test.ts` + `viewerPages.test.ts`).
- `bun run --cwd apps/web build`: `vite build` exit 0 (`2949` modules transformed in `244ms`).

## Wave 5 Live Win11 Host Verification (`192.168.0.27`, `media-server`)
- `/health/live` & `/health/ready`: HTTP `200`, `sqliteVersion: "3.53.4"`, `synchronousMode: "FULL"`, `dbIntegrity: "ok"`.
- Live Schema v14 migration: `PRAGMA user_version = 14`, `PRAGMA synchronous = 2 (FULL)`, `assets = 13080`, `folders = 113`, `views = 3` (zero data loss).
- Host Explorer & Security: `/api/fs/drives` returns `C:\` (510.9 GB), `D:\` (2.00 TB), `E:\` (1.00 TB); `/api/fs/browse?path=drives/e` returns folders; `/api/fs/browse?path=drives/c/Windows` blocked (`403`).
- Backups & Ops: `POST /api/backups` created `mediavault-2026-11-18T03-25-13-870Z-mwxsyb.db` (`334,450,688` bytes, `integrity: "ok"`); `scripts/windows/check-health.ps1` passed on Win11 PowerShell.
- Live 13,080-asset DrvFS Scan (`/mnt/e/d`): completed in **`3,432 ms`** (`scan.summary`: `files: 13080, unchanged: 13080, removed: 0`; `worker-1` idle CPU **`0.54%–1.55%`**, RSS **`34.4–51.1 MiB`**).
- Live Win11 `D:\` DrvFS 1k Benchmark (`scripts/bench-scan.ts --count=1000 --dir=/media/drives/d`): `enumMs: 111`, `statMatrix {1:2390, 4:213, 8:155, 16:137, 32:141}`, `probeMatrix1kSubset {1:77143, 4:7754, 8:5525, 16:5503, 32:5529}`, `dbUnbatched1kMs: 2700`, `dbBatched250Ms: 35`, `initialScanMs: 9064`, `incrementalScanMs: 1569`, `rssMb: 110.5`.
- Live Crash Recovery: `jobId 15468` auto-recovered expired lease and finished `13,080` files (`16.43s` resumed + verify); kernel `SIGKILL` to live worker PID `157691` auto-revived `mediavault-worker-1` (`PID 158150`) in **`5s`** with `recovery_logs` (`db_integrity: "ok"`) and `13,080` assets intact.

## Wave 6 Post-Audit Hardening Verification
- `bun run typecheck`: exit `0` across all 6 workspaces (`packages/{shared,database,media}`, `apps/{api,worker,web}`).
- `bun test`: **`284 pass, 0 fail`** across 34 files (including new tests for cancelled scan non-resurrection, `lease_lost` batch rollback, deep symlink-to-Windows `403`, paused scan resume, non-double-counted `storageStats`, TZ-independent KST vote calendar, and narrow-container panorama layout).
- `apps/asr-worker/.venv/bin/pytest`: **`110 passed, 1 skipped`**.
- `bun run --cwd apps/web build`: `vite build` exit `0`.
- Live post-Wave-6 verification on `media-server` (`192.168.0.27`): executed after Wave 6 bundle deploy (`api`, `worker`, `web`, `nginx`).

## Spec v1.0 PR 00 Baseline Verification (2026-11-19)

- Baseline commit: `aceb0ade51f464c94e8f148d6a9da3445e7a6d37` (`main`), schema `v15`.
- `bun run typecheck`: exit `0` across 6 workspaces.
- `bun test`: **`298 pass, 0 fail`**, `1137` expect calls, 36 files, `7.68s`.
- `bun run --cwd apps/web build`: exit `0`, built in `609ms`.
- `apps/asr-worker/.venv/bin/pytest apps/asr-worker`: **`110 passed, 1 skipped`**, `17.31s`.
- Host read-only DB check: `user_version = 15`, `integrity_check = ok`, `foreign_key_check = 0`, assets `12,756`, folders `113`, tags `63`, libraries `1`, `playback_progress` `191`, `vote_events` `1`.
- Latest host backup `mediavault-2026-11-19T03-25-54-233Z-r777ns.db`: v15, integrity `ok`, FK `0`, same counts.
- Restore rehearsal on `/tmp/restore-rehearsal.db` inside `mediavault-api-1`: integrity `ok`, FK `0`, counts match; temp file removed. Production DB and backup original untouched.
- Not verified in PR 00: Windows unattended boot rehearsal, full Docker Compose render, real GPU inference. These belong to later PRs and the release gate.

## Spec v1.0 PR 01 Verification (2026-11-19)

- `bun run typecheck`: exit `0`, including the new root `tsconfig.json` check for `scripts/**/*.ts`.
- `bun test`: **`309 pass, 0 fail`**, `1157` expect calls, 37 files, `7.63s` (11 new preflight tests).
- `bun run --cwd apps/web build`: exit `0`, `206ms`.
- `docker compose --env-file .env.example -f compose.yaml -f compose.drives.yaml config`: exit `0`. Rendered 5 mounts per media service, `create_host_path: false` on every bind.
- `docker compose --env-file .env.example -f compose.yaml config`: exit `0` (single-root host).
- `docker compose --env-file .env.example -f compose.yaml -f compose.dev.yaml config`: exit `0`; the `!override` tag replaced the production media bind with `./sample-media`.
- `docker compose` with an empty env file and an empty project directory: exit `1` with `required variable MEDIA_ROOT is missing a value`, which is the intended fail-fast.
- ASR/scene compose render with example env files and test tokens: exit `0`; 21 drive mounts and 7 extra-root mounts across api, worker, nginx, asr-worker and scene-worker.
- `git check-ignore`: `.env.scene` and `.env.asr.bak-langid` match `.env.*`; `.env.example` and `.env.asr.example` remain unignored.
- Not verified yet: live host restart with the new compose files. That check follows the commit and is recorded below when it runs.

### PR 01 Live Host Verification (`media-server`, 2026-11-19)

- Backed up the host `.env` to `~/Pmanager-backups/pre-pr01-20261119-202606.env` before editing.
- Set `MEDIA_ROOT=/mnt/e` on the host. Before this change `/media` was bound to `./sample-media`; the only library is `extra/d`, so no registered asset depended on the sample folder.
- Host full compose render with all 5 env files and 11 compose files: exit `0`, 8 `create_host_path: false` entries.
- Rebuilt and recreated `api`, `worker`, `nginx`: `UP_EXIT=0`. `api` reached `healthy`.
- Container preflight: `5 paths, 0 failed, 1 warnings`; `/media` `352.6 GiB`, `/media/extra` `352.6 GiB`, `/media/drives/c` `84.3 GiB`, `/media/drives/d` `1402.6 GiB`, `/media/drives/e` `352.6 GiB`. The warning is expected because `/media`, `/media/extra`, and `/media/drives/e` all resolve to the E drive.
- `/health/ready`: HTTP `200`.
- Live mounts: `/mnt/e -> /media`, `/mnt/e -> /media/extra`, `/mnt/c -> /media/drives/c`, `/mnt/d -> /media/drives/d`, `/mnt/e -> /media/drives/e`.
- DB after restart: schema `v15`, `12,851` active assets, `115` folders, `63` tags, `1` library. The latest three scans each saw `12,851`, `files_added: 0`, `files_removed: 0`, `read_errors: 0`.
- Baseline at PR 00 was `12,756` assets and `113` folders. The increase of 95 assets and 2 folders happened before the latest scans and is not a deletion. The exact scan that added them was not captured; later scans are stable at `12,851`.

## Spec v1.0 PR 02 Verification (2026-11-19)

- `bun run typecheck`: exit `0` across all 6 workspaces plus the root scripts project.
- `bun test`: **`318 pass, 0 fail`**, `1195` expect calls, 38 files, `7.95s`.
- `bun run --cwd apps/web build`: exit `0`, `249ms`.
- New scanner tests cover a disconnected root, an empty mount boundary, a small library with 5 missing of 10 (the old 50-asset floor would have allowed it), a total root loss with `SCAN_DELETE_FORCE=1`, a force-allowed partial deletion on a healthy root, and a changed root identity. Every blocking case leaves `deleted_at` unchanged.
- New v16 tests cover migration from a v15 database, health backfill from the latest completed scan, failure counting and reset, verify preserving `last_success_at`, and scan-run mount and deletion fields.
- API test covers `UNVERIFIED`, `ONLINE`, `root_missing`, and `root_empty` through `GET /api/libraries`, `GET /api/libraries/:id/health`, and `POST /api/libraries/:id/verify`.
- Migration rehearsal on `/tmp/pm-v15-clone.db` (copy of `mediavault-2026-11-19T03-25-54-233Z-r777ns.db`): `user_version 15 -> 16`; before and after counts identical at assets `12,756`, folders `113`, tags `63`, libraries `1`, `playback_progress` `191`, `vote_events` `1`; `integrity_check = ok`; foreign-key violations `0`; `library_health` backfilled `ONLINE` with `last_success_at` matching the latest completed scan; all five new `scan_runs` columns present.
### PR 02 Live Host Verification (`media-server`, 2026-11-19)

- Pre-migration read-only check: `user_version = 15`, assets `12,851` (`12,852` rows), folders `115`, tags `63`, libraries `1`, `playback_progress` `191`, `vote_events` `1`, `scan_runs` `117`, `jobs` `13,425`, `integrity_check = ok`, foreign-key violations `0`.
- Stopped `api` and `worker`, then took a pre-v16 backup with `VACUUM INTO` into `~/Pmanager-backups/pre-v16-20261119-203907/mediavault.db` (259 MB) plus `secret.key` and an `.env` snapshot. Backup verification: same counts as live, `integrity_check = ok`, FK `0`.
- Ran the single migrator from the freshly built `api` image: `user_version 15 -> 16`, all nine counters identical, `integrity_check = ok`, FK `0`, `library_health` backfilled `ONLINE` with `last_success_at = 1795088294420` (the latest completed scan).
- Rebuilt `api`, `worker`, `web`; started with `--no-deps`; restarted `nginx`. `/health/ready` returned `200` and the API answered `401` without a session, as expected.
- `GET /api/libraries`: `healthState: "ONLINE"`, `healthErrorCode: null`, `healthConsecutiveFailures: 0`. `GET /api/libraries/:id/health` returned the backfilled record plus the latest scan run.
- **Accidental guard rehearsal:** a concurrent supervisor `docker compose up` recreated `api` and `worker` without `compose.drives.yaml`, so `/media/extra` was absent for about two minutes. The scanner refused to run and wrote a blocked run `n1r14znxmbaj` with `phase: "blocked"`, `healthState: "OFFLINE"`, and `drive_unavailable: cannot access extra/d (ENOENT ...)`; `consecutive_failures` reached `4`; `deleted_at` was never touched. This is the exact failure mode PR 02 exists to stop, observed on live data.
- After recreating `api`, `worker`, `nginx` with the drives file, `POST /api/libraries/:id/verify` moved the library to `ONLINE` with `rootIdentity: "73:4503599627428555"` (E drive).
- Follow-up scan `hh66pd8emnej`: `filesSeen 12,851`, `filesAdded 0`, `filesUpdated 0`, `filesRemoved 0`, `readErrors 0`, `missingCount 0`, `missingRatio 0`, `authoritativeVerified true`, `healthState "ONLINE"`, `4,488 ms`. Worker log: `scan.summary files=12851 unchanged=12851 removed=0`.
- Settings page in headless Chrome with a minted session cookie: the library row shows the green `정상` badge next to `d`, the subtitle `extra/d · 12,851개 · 2026년 11월 19일 오후 08:42 스캔`, and `스캔` / `제거` buttons. No `연결 확인` button appears for an `ONLINE` library, which is the intended behavior. Layout is intact.
- Unrelated pre-existing failures observed while checking: ASR alignment failures (`alignment produced no timestamps for any chunk`) and three archive jobs from `2026-11-19T05:43Z` with `archive volume disappeared while stabilizing`. Neither is caused by PR 02; the ASR worker and archive code were not modified.
