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
