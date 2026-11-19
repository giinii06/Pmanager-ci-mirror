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
