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
