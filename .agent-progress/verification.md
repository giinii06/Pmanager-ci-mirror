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

## Spec v1.0 PR 03 Verification (2026-11-19)

- `bun run typecheck`: exit `0` across all 6 workspaces plus the root scripts project.
- `bun test`: **`352 pass, 0 fail`**, `1334` expect calls, 43 files, `8.57s` (PR 02: `318`/38 files).
- `bun run --cwd apps/web build`: exit `0`, `218ms`. The final deslop pass touched only API/DB/worker files, so the web bundle is unchanged since this build.
- v17 rehearsal on a `VACUUM INTO` clone of the live v16 database (`/tmp/pm-v16-clone.db`, 259 MB): `user_version 16 -> 17`; before and after counters identical at assets `12,851` active / `12,852` total, folders `115`, tags `63`, libraries `1`, playback `191`, votes `1`, `scan_runs` `123`, `jobs` `13,429`, `library_health` `1`; `integrity_check = ok`; foreign-key violations `0`; `file_mutations`, `mutation_events`, and `assets.pending_delete_mutation_id` created.
- SIGKILL coverage: `apps/worker/src/mutations-kill.fixture.ts` is spawned as a real Bun process and killed with SIGKILL at four durable boundaries. After each kill the test asserts the surviving state (tombstone + source after `validated`; source gone + quarantine file after `quarantined`; asset row gone + quarantine file after `db_committed`; both paths gone + `purging` after the final unlink), then expires the lease and resumes. Every stage reaches `completed` with the asset and both file paths gone.
- Bun commits `db.transaction()` natively, so a kill inside a transition would roll it back. The fixture kills between steps, and the purging kill fires on the pre-check of the `completed` transition. The narrower window (rename done, state still `validated`) is covered by the in-process resume test instead.
- Quarantine placement tests cover mountinfo parsing with octal escapes, longest-mount selection, ignoring mounts outside the media root, the device-walk fallback, a `0o700` quarantine directory, symlink refusal, and `..` escape rejection.
- `EXDEV` mapping (`isCrossDeviceRename`) is unit-tested. A real cross-device rename cannot be produced on the macOS temp filesystem and is not reachable through `planQuarantine` by design, because placement always follows the source mount; the Linux host remains the place to observe it if a mount is ever mis-detected.
- API tests: 503 with the engine off, `Idempotency-Key` required, repeat key returns the same operation, `GET /api/file-operations/:id`, 409 for an offline library, 404 for unknown assets and operations, retry refused while `requested`, and the legacy `DELETE` queues without touching the file.
- Worker tests: full happy path with cache purge, request-key dedupe, offline library, version conflict, symlinked source, identity mismatch, tombstone at `validated`, a scan that cannot resurrect an in-flight delete, crash after rename, crash between commit and purge, `quarantine_lost` block keeping the row, a lost lease that cannot write, and a missing source that blocks.

### PR 03 Live Host Verification (`media-server`, 2026-11-19)

- Shipped `55e7549` (plus the `23e4f03` docs commit) by bundle from host `28cd1eb`; `git merge --ff-only` fast-forwarded cleanly.
- Pre-migration read-only check: `user_version = 16`, assets `12,851` active (`12,852` rows), folders `115`, tags `63`, libraries `1`, playback `191`, votes `1`, `scan_runs` `123`, `jobs` `13,429`, `library_health` `1`, `integrity_check = ok`, FK `0`.
- Stopped `api` and `worker`, then took a pre-v17 backup with `VACUUM INTO` into `~/Pmanager-backups/pre-v17-20261119-212607/` (`mediavault.db` 259 MB, `secret.key`, and snapshots of `.env`, `.env.asr`, `.env.translation`, `.env.embedding`, `.env.scene`). Backup verification: same counts, `integrity_check = ok`, FK `0`.
- Rebuilt `api`, `worker`, `web`; ran the single migrator from the new image: `user_version 16 -> 17`, all nine counters identical, `integrity_check = ok`, FK `0`, `file_mutations` and `mutation_events` present, `assets.pending_delete_mutation_id` present.
- Started with `up -d --no-deps api worker web` and restarted `nginx`; `api` reached `healthy`.
- `/health/ready` `200`, `/` `200`, unauthenticated `/api/libraries` `401`. With a minted session: one library `d`, `healthState "ONLINE"`, `assetCount 12,851`, `folderCount 115`, `healthConsecutiveFailures 0`.
- Engine-off checks on live data: `DELETE /api/assets/000a16w15g43` and `POST /api/assets/000a16w15g43/delete-operations` both returned `503 mutation_engine_disabled`; `file_mutations` and `mutation_events` stayed at `0`. The API log recorded `file mutation engine disabled; refusing a delete request`, and the worker log had no mutation activity, so the loop stayed dormant.
- Manual scan `9jh5ekqzpers`: `filesSeen 12,851`, added/updated/removed `0`, `readErrors 0`, `missingCount 0`, `authoritativeVerified true`, `healthState "ONLINE"`; active assets stayed `12,851`.

## Spec v1.0 PR 04 Verification (2026-11-19)

- `bun run typecheck`: exit `0` across all 6 workspaces plus the root scripts project.
- `bun test`: **`376 pass, 0 fail`**, `1436` expect calls, 46 files, `8.58s` (PR 03: `352`/43 files).
- `bun run --cwd apps/web build`: exit `0`, `184ms`. The served bundle `Lightbox-Dq4AUOyj.js` on the host contains the new `source_offline` branch and the offline message, so the deployed player is the new one.
- v18 rehearsal on a `VACUUM INTO` clone of the live v17 database (`/tmp/pmanager-v17-live.db`, 259 MB): `user_version 17 -> 18`; before and after counters identical at assets `12,851` live / `12,852` total, folders `115`, tags `63`, `asset_tags` `331`, `asset_reviews` `0`, playback `191`, `watch_time_ms` `908,884`, libraries `1`, jobs `13,431`, `file_mutations` `0`; `integrity_check = ok`; foreign-key violations `0`; `hls_generations`, `hls_active`, and `trg_assets_version_clears_hls_active` present.
- v18 tests cover the migration, one pending generation and one job per request, dead-job re-enqueue, publication fencing on an expired lease, a version change that refuses publication, `request_seq` freshness so a late older publish cannot displace a newer active one, GC protection for the active generation, and orphan reconciliation.
- Media tests use a fake ffmpeg binary (`FFMPEG_PATH`) that writes structurally valid MPEG-TS segments and a VOD playlist, and covers progress parsing, the NVENC-unavailable fallback, abort, `canPublish = false`, a bad segment, and a bad playlist.
- API tests cover a queued request, a ready playlist and segment, a missing segment, a foreign generation id, a ready cache while the library is offline, no cache while offline (`503 source_offline`), a failed generation plus retry, the legacy playlist pinned to the active generation, and the flag-off legacy path.
- Player behaviour: status polling is bounded at 30s with an `AbortController`; the retry button only calls the API when the failure is not `source_offline`; hls.js recovery is capped at 3 network and 2 media attempts per mount.

### PR 04 Live Host Verification (`media-server`, 2026-11-19)

- Shipped `deb605c` (with `5b2fa8c`) by bundle from host `55e7549`; `git merge --ff-only` fast-forwarded cleanly.
- Pre-migration read-only check: `user_version = 17`, assets `12,851` live (`12,852` rows), folders `115`, tags `63`, libraries `1`, `integrity_check = ok`, FK `0`.
- Took a pre-v18 backup with `VACUUM INTO` into `~/Pmanager-backups/pre-v18-20261119-220112/` (`mediavault.db` 259 MB, `secret.key`, and snapshots of `.env`, `.env.asr`, `.env.translation`, `.env.embedding`, `.env.scene`). Backup counters match the live DB.
- Rebuilt `api`, `worker`, `web`, started them, and restarted `nginx`; `api` reached `healthy` within 11s.
- Live schema is `v18`; counters unchanged at `12,851` live assets, `115` folders, `63` tags, `1` library; `hls_generations` and `hls_active` are `0` because the flag is off; library health is `ONLINE`.
- `/health/ready` `200`, `/` `200`, unauthenticated `/api/libraries` `401`, authenticated `200`.
- With the flag off, a cached video reports `{"state":"ready","playlistUrl":"/api/assets/<id>/hls/master.m3u8","progressPercent":100}`, the legacy `master.m3u8` returns `200`, and the generation route returns `404`. The asset DTO carries the new `hlsStatusUrl`.
- Worker logs contain no `worker.hls.gc` or `worker.hls.gc_failed` lines: the GC pass ran with nothing to reconcile or collect.

## Spec v1.0 PR 05 Verification (2026-11-19)

- `bun run typecheck`: exit `0` across all 6 workspaces plus the root scripts project.
- `bun test`: **`402 pass, 0 fail`**, `1570` expect calls, 48 files, `13.19s` (PR 04: `376`/46 files).
- `bun run --cwd apps/web build`: exit `0`, `212ms`. No web source changed in PR 05; the existing SPA already reads `authenticated` from `/api/auth/status`.
- Argon2id parameters measured on the Mac: `hash 59 ms`, `verify 55 ms` at `memoryCost 65536, timeCost 2`.
- v19 rehearsal on a `VACUUM INTO` clone of the live v18 database (`/tmp/pmanager-v18-live.db`, 259 MB): `user_version 18 -> 19`; counters identical at assets `12,851` live / `12,852` total, folders `115`, tags `63`, `asset_tags` `331`, users `2`, playback `191`, `watch_time_ms` `908,884`, libraries `1`, jobs `13,433`, `file_mutations` `0`, `hls_generations` `0`; `integrity_check = ok`; foreign-key violations `0`; `user_sessions`, `auth_login_attempts` and `auth_events` created; both users still carry `scrypt` hashes for the on-login upgrade.
- Both live scrypt hashes parse under the new strict verifier and return `{ ok: false, needsRehash: true }` for a wrong password in 18–20 ms, with no exception. This proves the stored profile is accepted; the correct password would take the same path and then rehash.
- Route tests: argon2id format and verify; legacy scrypt verify plus rehash flag; malformed/oversized scrypt rejected without throwing; login upgrades a scrypt row to `$argon2id$`; cookie flags (`HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age=2592000`) and `Cache-Control: no-store`; logout revokes; session list marks the caller; another user's session id is a 404 and stays valid; logout-all kills every session; password change refuses a wrong current password, replaces all sessions, updates the hash, and only the new password logs in; malformed cookies are ignored; two concurrent setup calls produce `201` and `409` with one user; ten failures produce `429` with `Retry-After`; the per-IP limit counts attempts; a forwarded header from an untrusted peer does not create a new client identity; cross-origin, `null` origin and `cross-site` fetch metadata are `403` while the same origin and safe methods pass; a worker route is `401` without its token.

### PR 05 Live Host Verification (`media-server`, 2026-11-19)

- Shipped `be9071f` by bundle from host `4947eff`; `git merge --ff-only` fast-forwarded cleanly.
- Took a pre-v19 backup with `VACUUM INTO` into `~/Pmanager-backups/pre-v19-20261119-222438/` (`mediavault.db` 259 MB, `secret.key`, and the five env snapshots). Counters match the live DB.
- Rebuilt and recreated only `api` (worker and web unchanged), then restarted `nginx`. `api` reached `healthy` in 12 s. Live schema is `v19`; `user_sessions` and `auth_events` are empty; `12,851` active assets unchanged.
- `/health/ready` `200`, `/` `200`. The old HMAC cookie returns `401`, and `/api/auth/status` reports `{setupRequired:false, authenticated:false, user:null}` — the documented one-time sign-out.
- `docker exec mediavault-api-1 bun scripts/mint-session.ts` printed a token; `/api/libraries` returned `200`, `/api/auth/status` reported `giini`, and `/api/auth/sessions` listed one row with `current: true` and a 30-day expiry. `POST /api/auth/logout` returned `204` and the same token then returned `401`.
- Origin checks through nginx: `Origin: http://evil.example` → `403`; `Origin: null` behaviour covered by tests; `Origin: http://127.0.0.1:8080` and `http://192.168.0.27:8080` → `401` (reaches login); an origin without the port → `403`.
- **Bug found and fixed during verification:** nginx forwarded `Host $host`, which drops `:8080`, so every same-origin state-changing request was refused. `d9fbf87` switches `/api/` to `Host $http_host`; after the restart the same-origin login request reached the route.
- Live rate limit: ten wrong passwords for a non-existent username produced `429` with `retry-after: 899`. The real account names were not used, so no operator login was locked.
- API and worker logs since the deploy contain no errors.

## Spec v1.0 PR 06 Verification (2026-11-19)

- `bun run typecheck`: exit `0` across all 6 workspaces plus the root scripts project.
- `bun test`: **`431 pass, 0 fail`**, `1682` expect calls, 51 files, `14.07s` (PR 05: `402`/48 files).
- `bun run --cwd apps/web build`: exit `0`. The served bundle on the host contains `api/play-sessions`, so the deployed player is the new one.
- v20 rehearsal on a `VACUUM INTO` clone of the live v19 database (`/tmp/pmanager-v19-live.db`, 259 MB): `user_version 19 -> 20`; before and after counters identical at assets `12,852` total / `12,851` live, folders `115`, tags `63`, `asset_tags` `331`, `asset_reviews` `0`, playback `191`, `watch_time_ms` `908,884`, views `178`, libraries `1`, jobs `13,434`, votes `1`, `hls_generations` `0`; `integrity_check = ok`; foreign-key violations `0`; `play_sessions` and `play_events` created; the four `playback_progress` columns exist and all `191` rows carry the asset's `file_version`.
- v20 tests cover the migration and backfill, one view per session even under retry, contiguous sequence acceptance and `expectedSeq` on a gap, a reused sequence as `sequence_conflict`, an `event_id` replay with the same payload as a duplicate and with a different payload as `event_id_conflict`, a file-version change refusing new events while a committed event still answers as a duplicate, legacy progress fenced after a session writes, session-key idempotency across users, and the 90-day prune counting only session rows.
- API tests cover session create `201` and retry `200`, a non-video asset `404`, a deleted asset `404`, an old `file_version` `409`, event payload validation `400`, an unknown session `404`, a gone asset `410`, and the duplicate response shape.
- Resume tests cover explicit `startMs` priority, a this-session seek beating the saved record, `<= 5s` ignored, near-end treated as finished, and a late offer not moving an applied position.
- Runtime exercise against the migrated clone (`DATA_DIR=/tmp/mv-v20-runtime`, `PORT=8091`): session create `201` then retry `200` with the same id; `view` `applied` then `duplicate` with the view count still `1`; `watch_time` `applied` then `duplicate` with `watch_time_ms` unchanged; `progress` stored; skipping to `seq 4` returned `409 sequence_gap` with `expectedSeq`; reusing a committed seq returned `409 sequence_conflict`; the legacy view and watch-time routes still returned `200`; the legacy `PUT` returned `204` but left the position at `30,000` (fenced); a vote retry left `voteCount` at `1`.
- **Logout re-check (false alarm resolved).** The post-deploy `logout` returned `204` while the same cookie still authenticated. Re-tested with one fixed token: `before 200`, `logout 204`, then `401` on three consecutive polls, and the `user_sessions` row carries `revoked_at`. A direct SQLite revocation is also visible on the very next request. The earlier reading was a test-procedure error: `scripts/mint-session.ts` inserts a **new** session on every run, so the "after" check used a different, valid token. No code change was needed.
- Live host after deploy (`media-server`, `845d81a`): schema `v20`, assets `12,852` total / `12,851` live, folders `115`, tags `63`, playback `191`, `watch_time_ms` `908,884`, views `178`, jobs `13,435`, votes `1`, `play_sessions` `0`, `play_events` `0`, `integrity_check = ok`, FK `0`; `/health/ready` `200`, `/` `200`; unauthenticated `/api/libraries`, `POST /api/play-sessions` and an event post all `401`; a minted session reads `/api/auth/status` `200` and `/api/playback/<id>` `{"progress":null}`; no API or worker errors in the deploy window.

## Spec v1.0 PR 07 Verification (2026-11-19)

- `bun run typecheck`: exit `0` across all 6 workspaces plus the root scripts project.
- `bun test`: **`453 pass, 0 fail`**, `2526` expect calls, 54 files, `13.88s` (PR 06: `431`/51 files).
- `bun run --cwd apps/web build`: exit `0`, `239ms` (only the existing chunk-size warning).
- Database tests: the neighbour is compared against the full `listAssets` order for `latest`, `name`, `views`, `watch_time`, `votes` and `rate` (seeded), for every adjacent pair and both ends; a second test proves a different seed moves both the list and the neighbour together; anchors that are deleted return `missing`, and an image under a `kind: 'video'` filter returns `outside_filter`. Random tests prove exclusion of the current and recent ids over 60 seeds, relaxation when only recent candidates remain, `null` for an empty or current-only filter, and full coverage of 26 assets over 1,200 unseeded draws with every count between 5 and 130.
- API tests: neighbour follows `GET /api/assets?kind=video&sort=latest` for the first four steps and the `prev` direction, the last item returns `204`, an unknown id `404`, a filtered anchor `409 anchor_not_in_filter`, an invalid direction `400`; random stays inside the filter and avoids the current/recent ids for five seeds, an empty folder returns `204`, and both routes return `401` without a session.
- Viewer tests stub `fetch`: a neighbour response appends and focuses the asset; a response for an older request cannot replace a newer `select`; a response after `close` is discarded; shuffle calls `/api/assets/random` and appends the pick; a single shared-link asset with no filter issues no request.
- Benchmark (`scripts/bench-navigation.ts`, live `VACUUM INTO` clone, schema v20, `12,851` active assets, SQL time only): worst neighbour p95 `12.84 ms` (`rate`, `12,653` images); `latest` over all assets `4.68 ms`; random p95 `3.49 ms` (images) and `2.72 ms` (all). The 12.8k budget of p95 `100 ms` is met with an order of magnitude to spare. The 200k estimate (~`190 ms`) is an inference, not a measurement, and is recorded as such in `docs/BENCHMARKS.md`.
- ChatGPT consultation `mediavault-pr07-navigation-01` (status `completed`) recommended Option A and the eligible-set random sampler; both were adopted. Its keyset/hybrid suggestion was deferred with the benchmark as the trigger, and its warning about the unfiltered shared-link scope was implemented by passing an explicit filter at the call site.

### PR 07 Live Host Verification (`media-server`, 2026-11-19)

- Shipped `3881e44` by bundle from host `845d81a`; `git merge --ff-only` fast-forwarded cleanly (17 files, `+1233/-98`).
- No schema change: live `user_version` stayed `20`; counters unchanged at assets `12,852` total / `12,851` active, folders `115`, tags `63`, playback `191`, `watch_time_ms` `908,884`, views `178`, libraries `1`, votes `1`, `play_sessions`/`play_events` `0`; `integrity_check = ok`; FK `0`.
- Rebuilt only `api` and `web`, recreated them with `--no-deps`, and restarted `nginx`; `api` reported `healthy` within 6 s.
- `/health/ready` `200`, `/` `200`; unauthenticated `GET /api/assets/<id>/neighbor` and `POST /api/assets/random` both `401`.
- With a minted session, `GET /api/assets?kind=video&sort=latest&limit=3` returned `2j2prmy8v1n4`, `ep3jp27mc5j6`, … and `GET /api/assets/2j2prmy8v1n4/neighbor?direction=next&kind=video&sort=latest` returned exactly `ep3jp27mc5j6`, so the server order matches the list on live data.
- `POST /api/assets/random` with `{kind:'video', currentAssetId:'2j2prmy8v1n4', recentIds:['ep3jp27mc5j6']}` returned `200` with `xwjmx30j3h4j`, which is neither the current nor the recent asset; the same route with a folder that has no assets returned `204`.
- The served bundle `index-BBoWepTI.js` contains both `assets/random` and `neighbor`, so the new client is the one being served. API and worker logs since the restart contain no errors.

## Spec v1.0 PR 08 Verification (2026-11-19)

- `bun run typecheck`: exit `0` across all six workspaces and the root scripts project.
- `bun test`: **`470 pass, 0 fail`**, `2587` expect calls, 55 files, `15.66s` (PR 07: `453`/54 files).
- `bun run --cwd apps/web build`: exit `0` (only the existing chunk-size warning).
- `apps/scene-worker/.venv/bin/pytest -q`: **`28 passed`**, including the four new `test_processes.py` cases.
- Job-queue tests: a long-waiting priority-2 job is claimed before a fresher priority-1 job after two aging levels; a `SOURCE_OFFLINE` failure is stored as `[SOURCE_OFFLINE] …`, lands in `failed` on the first attempt, and is requeued only after `markLibraryHealthy` (and not twice); a paused row with the same dedupe key blocks the requeue instead of raising a constraint error; an `INTERNAL` failure still retries with backoff.
- Work-queue tests: `sceneWindowCount` matches the Python plan (`8`, capped `2`, single-window short file, `0` for no duration); a scene row reports `coverage { analyzed: 2, total: 8, sampled: true }`, flips `waitingGpu -> onGpu` when the lease is acquired, and a `[PROCESS_TIMEOUT]` scene failure surfaces code and message separately; a cross-lane test (ASR holder with a 20 s median, embedding waiter with a 20 s median) reports holder `15 s` and waiter `35 s` at +5 s, and the waiter still reports `25 s` at +15 s, proving the wait does not shrink its own estimate.
- Classifier tests: `ENOSPC`/`EACCES`/`EPERM`/`ENOENT`/`EISDIR`/`EILSEQ`, `HlsAbortedError`, `ProcessTimeoutError`, timeout/abort/corrupt message patterns, and `INTERNAL` for unknown values (including `null` and a string).
- Bounded-ffmpeg tests: a `slow` fake encoder is killed at a 400 ms wall clock with `ProcessTimeoutError` in ~400 ms; an abort after 100 ms raises `HlsAbortedError` without waiting for the 60 s budget; a `tree` fake encoder that spawns a sleeping helper has both processes gone after a 1.5 s timeout.
- Python process tests: `run_checked` returns stdout, reports `exited with 3` plus the stderr tail, kills a sleeping grandchild on timeout (`[PROCESS_TIMEOUT]` message, child gone within 5 s), and `terminate_group` escalates to KILL when SIGTERM is ignored (grace patched to 0.3 s).
- Rehearsal on a `VACUUM INTO` clone of the live database (259 MB, schema v20): `workQueue` returns the nine lanes; the clone's `198` scene jobs are all `completed`, so a copy of the longest row was switched to `extracting` in the clone only and reported `coverage 120/1726` for a `13,803,991 ms` file with `waitingGpu: true`; `requeueSourceOfflineJobs` returned `0` (all eight failed media rows predate the code prefix); `PRAGMA integrity_check = ok`.
- Live host after deploying `fb8e525`, `9d994c4` and `e076d9b` (`media-server`): schema stayed `v20`; assets `12,851` active, folders `115`, tags `63`, playback `191`, views `178`, watch `908,884`, votes `1`, failed jobs `8`, integrity `ok`, FK `0`; `/api/queue` is `401` unauthenticated and returns `runningGpu`/`waitingGpu`/`basis`/`coverage`/`errorCode` with a minted session; the served bundle contains `GPU 대기` and `구간`; the API and scene-worker containers carry `SCENE_MAX_WINDOWS=120`, and the recreated scene worker carries `SCENE_STAGE_TIMEOUT_SECONDS=3600` and `SCENE_FFMPEG_TIMEOUT_SECONDS=300`; no API, worker or scene errors in the deploy window.
- Not verified live: a real coded failure, an offline-source requeue, and a scene job running through the new watchdog. Each needs a controlled fault on production data; they are covered by unit tests and the clone rehearsal, and are listed as unverified rather than claimed.

## Spec v1.0 PR 08b Verification (2026-11-20)

- `bun run typecheck`: exit `0` across all six workspaces and the root scripts project.
- `bun test`: **`477 pass, 0 fail`**, `2612` expect calls, 56 files, `16.14s` (PR 08: `470`/55 files).
- `apps/scene-worker/.venv/bin/pytest -q`: **`39 passed`** (PR 08: `28`), including 10 new `test_checkpoint.py` cases and 2 `test_pipeline.py` protocol cases.
- `bun run --cwd apps/web build`: exit `0` (only the existing chunk-size warning).
- Checkpoint tests: five appends survive a restart with the same digest; `append` returns `True` only on the 5th unit (and with `CHECKPOINT_EVERY=2`, on the 2nd); a torn half-line is truncated and the next append starts at the right seq; deleting window 3's thumbnail cuts the reusable prefix to 3 and rewrites the manifest; a manifest from another model discards the log; a log one unit ahead of the manifest wins and the manifest is rewritten; a log past `totalUnits` stops at the planned total and truncates the extra line; `checkpoint_line()` is `CHECKPOINT 5 12 <digest>`.
- Protocol tests: `CHECKPOINT 5 120 <64 hex>` parses to `(5, 120, digest)`; `PROGRESS`, uppercase hex, non-hex and a short line return `None`.
- API tests: the first claim returns `checkpoint: null`; a saved checkpoint is stored and offered on the next claim with the same stage/units/path/hash; a foreign owner gets `409`; `completedUnits > totalUnits` gets `422 invalid_checkpoint`; a changed `model_sha256` makes the next claim drop the row and return `null`; completion stores `analyzed_windows = 5`/`total_windows = 6`, deletes the checkpoint and serves `coverage {analyzed: 5, total: 6}` from `GET /api/assets/:id/scenes`.
- v21 tests: a database built from the first 20 migrations upgrades to `21`, keeps a queued scene row's state and model SHA, leaves the two new columns `NULL`, and has `stage_checkpoints`; a second test upserts the same `(job, stage)` twice (the newer units/`updated_at` win), keeps `writing` separate, and deletes both.
- Rehearsal on a `VACUUM INTO` clone of the live database (259 MB, schema v20): before and after the migration the counters are identical (`12,851` active / `12,852` total assets, `115` folders, `63` tags, `191` playback, `178` views, `908,884` watch, `1` vote, `17,439` windows), `integrity_check = ok`, `0` FK violations; `user_version` is `21`; `analyzed_windows`/`total_windows` exist; `stage_checkpoints` exists; `workQueue` returns the nine lanes with `scene 0/0`; a checkpoint row was upserted, read back (`completedUnits 5`) and deleted (`1`).
- Live host: created a `271,544,320`-byte backup through `POST /api/backups` (`integrity: ok`) before shipping, then fast-forwarded `2701496 -> dede96c` (17 files, `+1161/-81`), rebuilt only `api` and `scene-worker`, and recreated them with `--no-deps`; `api` was `healthy` within 6 s.
- Live schema is `v21`; counters unchanged at assets `12,851` active / `12,852` total, folders `115`, tags `63`, playback `191`, views `178`, watch `908,884`, votes `1`, windows `17,439`, failed scene jobs `0`; `integrity_check = ok`; FK `0`; `stage_checkpoints` empty.
- `/health/ready` `200` with `synchronousMode FULL` and SQLite `3.54.1`; `/api/queue` with a minted session still returns the nine lanes (`media`…`bulk`, all `0/0`, `remaining 0`, `basis null`); `GET /api/assets/0525e2zbx4kr/scenes` returns `{scenes: 7, coverage: null}` (the job predates the coverage columns, as expected).
- The recreated scene worker logs `worker e89429512905-1 ready`, reports `checkpoint_dir /cache/scene-checkpoints`, `max_windows 120`, and the image carries `scene_worker.checkpoint` with `CHECKPOINT_EVERY = 5`. API logs since the restart contain no errors.
- Not verified live: a real scene job that stops mid-stage and resumes from the API checkpoint, and the post-completion directory cleanup. Both need a long real encode on production data; the file protocol, the API lifecycle and the migration are covered by the tests and the clone rehearsal, and the first real scene job after this deploy will exercise the path (the worker logs `reusing N of M windows` on a resume).

## Spec v1.0 PR 09 Verification (2026-11-20)

- `bun run typecheck`: exit `0` across all six workspaces and the root scripts project.
- `bun test`: **`499 pass, 0 fail`**, `2728` expect calls, 57 files (PR 08b: `477`/56).
- `bun run --cwd apps/web build`: exit `0` (only the existing chunk-size warning).
- Differential tests (`packages/database/src/search-fts.test.ts`, 16 cases): the trigram path and the LIKE oracle return identical ordered rows for 1-, 2- and 3-character Korean, spaced phrases, ASCII case variants, `%`, `_`, `\`, `"`, `😀학` against `😀학교`, decomposed Hangul, and a soft-deleted asset; the fixture is asserted non-empty so agreement is not empty-against-empty; the limit and order hold on both paths. The newest transcript wins and `seq` breaks ties.
- Index-follows-content tests: a rename drops the old name and keeps the new one; a hard delete leaves no index row; a soft delete keeps the row and the predicate drops it; deleting a transcript cascades its segments out of the index; the triggers do not change what a mutation reports (`RETURNING`, not `changes`).
- Readiness tests: an index that never saw the existing rows is rebuilt before it is trusted; a deliberately deleted index row is detected and repaired instead of served short; running the setup twice changes nothing; a plain table holding the index name disables the fast path; a handle that never ran the setup stays on LIKE; disabling disarms the triggers so writes still land, and re-enabling repairs the index.
- `ftsPhrase` tests: refuses fewer than three code points and control characters, counts code points so a surrogate pair is one character, quotes the term and doubles an embedded `"`.
- Benchmarks (`scripts/bench-search.ts`, `limit=20`, `iterations=40`):
  - Synthetic 10k assets / 100k segments / 100k scenes: dialogue rare `10.30 -> 0.08 ms`, dialogue 3-char `15.45 -> 3.41 ms`, dialogue 4-char `14.18 -> 1.20 ms`, filename rare `1.14 -> 0.03 ms`; every FTS row byte-identical to the oracle. Setup `542.8 ms`, verify `206.9 ms`.
  - Live clone (12,852 assets / 23,067 segments / 17,439 scenes / 52,317 embeddings, real fingerprint): filename `Suji` `0.48 -> 0.08 ms`; dialogue `씻어야` `1.82 -> 0.05`, `자기야` `1.86 -> 0.09`, `안 해` `1.90 -> 0.10`; all `equal=true`. 2-character Korean (`그래`, `생각`) and 1-character (`아`) stay on LIKE by design, as do terms above the candidate ceiling (`Vol`, `AI-Enhanced`). Setup `130.2 ms`, verify `61.4 ms`.
  - The first live run used the synthetic vocabulary, which does not occur in this library, so those rows compared empty against empty. The published table uses real words and the real fingerprint; the script gained `--names`, `--dialogue`, `--model-sha`, `--pipeline` and `--pipeline-query` for that reason.
  - A deliberately deleted index entry made the run print `equal=false` and exit `1`, proving the equality check is load-bearing.
- Scene scan: live clone `147.51 / 158.34 ms` p50/p95 with the real fingerprint and 30 hits. At 100k scenes `827.63 / 995.25 ms`; two exact-scan rewrites measured at `720-821 ms` (variant A, 9% faster to 7% slower across runs) and `737-753 ms` (variant B, different tie order), so the current implementation stays. The 500 ms ANN trigger is crossed only at 100k scenes and is deferred to PR 14.
- Concurrency: four pipelines back to back take `644 ms` at the live shape and `3,896 ms` at spec scale, equal to serial execution because the scans are CPU-bound on one event loop.

### PR 09 deploy (2026-11-20)

- Shipped `ed2c152` + `470e6ff` (`dede96c -> 470e6ff`, 30 files, `+1752/-37`) after a fresh `VACUUM INTO` backup of the v21 database (`271,560,704` bytes, `integrity: ok`, `12,852` assets).
- Rebuilt `api` and `worker` (the worker needed the `RETURNING` change too, or its next rename would have reported failure) and recreated both with `--no-deps`.
- `search.fts` on the first start: `enabled: true`, `assets 12,852`, `segments 23,067`, setup `201.2 ms` (includes the backfill), verify `74.1 ms`. Six triggers exist (`asset_search_ad/ai/au`, `segment_search_ad/ai/au`), and both `%_docsize` tables hold exactly the content counts.
- `/health/ready` `200` with `synchronousMode FULL` and SQLite `3.54.1`; schema stays `v21`; counters unchanged at `12,852` assets, `23,067` segments, `220` transcripts, `17,439` scenes; `integrity_check = ok`; `stage_checkpoints` still empty.
- **Live equality: all ten saved queries (`바다`, `바다로`, `학교`, `축제`, `coast`, `5%`, `드라이브`, `해변`, `노을`, `서울`) returned byte-identical response bodies** (same SHA-256 of the sorted JSON) to the pre-deploy snapshot taken before the FTS tables existed.
- Component timings inside the api container on the host with the index armed: dialogue FTS `0.04 ms` (LIKE `3.01 ms`), filename FTS `0.05 ms` (LIKE `4.21 ms`), 2-character dialogue `2.93 ms` (LIKE by design), scene scan `373.19 / 417.41 ms`. The endpoint is about `0.5 s` end to end, dominated by the unchanged scene scan; PR 09 does not touch that path.
- Not verified live: an asset rename or a permanent delete on real data (the `RETURNING` path). Both need a real library mutation; the unit test covers the trigger-inflated `changes()` case.

## Spec v1.0 PR 10 Stage A Verification (2026-11-20)

- `bun run typecheck`: exit `0` across all six workspaces and the root scripts project.
- `bun test`: **`525 pass, 0 fail`**, `2839` expect calls, 61 files (PR 09: `499`/57). New: `v22.test.ts` 3, `duplicates/hash.test.ts` 10, `duplicates/scan.test.ts` 8, `api/src/duplicates.test.ts` 5.
- `bun run --cwd apps/web build`: exit `0` (only the existing chunk-size warning).
- `packages/database/src/v21.test.ts` needed one change: it pinned `SCHEMA_VERSION` to `21` and a migration bump breaks it. It now uses `toBeGreaterThanOrEqual(21)`, matching `v20.test.ts`, so a later migration does not fail an older migration's test.
- Migration: a database migrated through the first 21 migrations upgrades to `22`, keeps its asset row, and gains `file_fingerprints`, `duplicate_groups`, `duplicate_group_members` plus `idx_file_fingerprints_full`, `ux_duplicate_groups_fingerprint` and `idx_duplicate_group_members_asset`.
- Group lifecycle: a rebuild keeps the id, `created_at` and the `kept` state while advancing `updated_at`; members are replaced rather than accumulated; a group whose fingerprint is no longer in the input is removed; an empty input clears the kind. `same_inode` round-trips as a boolean.
- A group with one live member is served by neither the list nor the detail, and `setDuplicateGroupState` returns `null` for it. Two fingerprints for two versions of one asset coexist and the older one is not deleted.
- Hash: identical bytes under different names (including a Hangul name) hash equal; one changed byte does not; an empty file hashes and `quickHash` reports it `whole`; a 5 MiB file with a single changed trailing byte hashes differently; a file at exactly 3 MiB is `whole` and its quick hash equals its full hash; 3 MiB + 1 byte is sampled and the two digests differ; a byte outside the sampled windows still separates two files; a file that grew between the stats raises `UnstableFileError`; each of size/mtime/inode/device is named by `stabilityViolation`; an already-aborted signal stops the read.
- Scan: identical pair → one group of two at confidence `1` with `totalBytes` 4096; same size different bytes → no group; a third file of another size is not even a candidate; a hardlink pair → one group, `hardlinked 2`, both members `sameInode`; a missing file → `missing 1` and the scan still finishes; a symlink to a file outside the library root → `refused 1` and no group; a rescan → `hashed 0, reused 2` and the `kept` decision intact; two scans leave `file_mutations`, `mutation_events` and `jobs` empty with no `pending_delete_mutation_id`.
- API: a scan queues exactly one `maintenance` job at priority `4` with `payload {"task":"duplicates"}`, and a second `POST` returns the same id; an unknown library is `404`. The list returns newest first, filters by state, pages with a cursor and rejects a malformed one with `400`; `kind=similar` returns `{groups: [], nextCursor: null}`. The detail carries `libraryName`, `rootPath`, `sameInode` and a `/api/assets/<id>/thumbnail` URL. `keep` then `ignore` both persist; `delete` is `409 delete_not_available` with the Korean message; an unknown action is `400`; a missing group is `404`; all four routes are `401` without a session; no mutation row exists afterwards.
- The tests are load-bearing, checked by mutation: returning `false` from `sharesInode` fails the hardlink test; disabling fingerprint reuse fails the rescan test; replacing the live-member count with a constant fails the single-member test. Each mutation was reverted before the run above.
- Hash throughput (macOS, Apple M5, 24 GiB, APFS, load average 3.74, warm page cache, median of 3 rounds after a discarded warm-up): full SHA-256 saturates at `2,762` MiB/s (64 MiB) and `2,785` MiB/s (512 MiB); quick reads exactly 3 MiB in `1.38-1.39 ms` regardless of file size; a 2 MiB file is read whole, so quick and full both measure about `2.6` GiB/s. This is a CPU ceiling, not a disk number; the host's DrvFS file-open latency dominates there (see `BENCHMARKS.md` §3.1).
- Not verified live: nothing is deployed. No migration, route or job has run against the host, and stage B (the UI page) does not exist yet.
