# PR 14 — search index builds (v26)

Synthesized from arena candidates A (DB-first) and B (artifact-first), the three `how`
maps, and the ops/search addenda. This document is the implementation contract.

Base: **A**, corrected. Grafts from B: adoption modes, `source` provenance, the
"claim vs fact" framing. Rejected from both: the artifact layer, the second state
table, the `seq` fence, two-phase GC, a new job lane, the cache type.

## Decision

The database is the only record of what the active search index is built from.
A **build** row says which index is live, what it covered, and whether it was
verified. Four SQL triggers make the one-active invariant unbreakable from any call
site. The rebuild runs **in the API process**, because readiness is a per-process
`WeakSet` that only a verification on that same handle can flip — a worker rebuild
would produce a correct index the API still refuses to use, and only a restart would
repair it. There is no file artifact for FTS: the index lives in the database, and
nothing in the repo writes under `<cache>/search-index/` (verified: the path appears
only in the spec). That directory, its manifest and `CURRENT` arrive with FAISS,
where the artifact is real.

### Second opinion

| request_id | status | outcome |
| --- | --- | --- |
| `pm-pr14-index-build-01` | unavailable | chrome-use relay dropped, `submitted: no` |
| `pm-pr14-index-build-02` | unavailable | same; retry exhausted per skill |

Consultation skipped, not blocked on. The decision below stands on the evidence in
this document.

## Naming

`search_index_builds` / `search_index_active`. Never "generation": that word already
means an HLS row, a `CacheScan.generation` hash and a cache-clean request field. UI
copy says 색인 build.

## Schema (v26, `MIGRATIONS[25]`, `SCHEMA_VERSION = 26`)

Additive only. `openDatabase()` already applies the array in one `IMMEDIATE`
transaction.

```sql
CREATE TABLE IF NOT EXISTS search_index_builds (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('fts','faiss')),
  state TEXT NOT NULL CHECK (state IN ('building','ready','superseded','failed')),
  source TEXT NOT NULL CHECK (source IN ('bootstrap','operator','boot-repair')),
  assets_count INTEGER NOT NULL DEFAULT 0,
  segments_count INTEGER NOT NULL DEFAULT 0,
  asset_watermark INTEGER NOT NULL DEFAULT 0,
  segment_watermark INTEGER NOT NULL DEFAULT 0,
  model_sha256 TEXT,
  pipeline_version TEXT,
  dimensions INTEGER,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  verified_at INTEGER,
  superseded_at INTEGER,
  last_error TEXT,
  CHECK (kind <> 'faiss'
    OR (model_sha256 IS NOT NULL AND pipeline_version IS NOT NULL AND dimensions IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_search_index_builds_kind_state
  ON search_index_builds(kind, state, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_index_builds_age
  ON search_index_builds(started_at);

CREATE TABLE IF NOT EXISTS search_index_active (
  kind TEXT PRIMARY KEY CHECK (kind IN ('fts','faiss')),
  build_id TEXT NOT NULL REFERENCES search_index_builds(id) ON DELETE RESTRICT,
  activated_at INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS si_active_ready_ins
BEFORE INSERT ON search_index_active
WHEN (SELECT state FROM search_index_builds WHERE id = NEW.build_id) IS NOT 'ready'
  OR (SELECT kind  FROM search_index_builds WHERE id = NEW.build_id) IS NOT NEW.kind
BEGIN SELECT RAISE(ABORT, 'active build is not ready'); END;

CREATE TRIGGER IF NOT EXISTS si_active_ready_upd
BEFORE UPDATE ON search_index_active
WHEN (SELECT state FROM search_index_builds WHERE id = NEW.build_id) IS NOT 'ready'
  OR (SELECT kind  FROM search_index_builds WHERE id = NEW.build_id) IS NOT NEW.kind
BEGIN SELECT RAISE(ABORT, 'active build is not ready'); END;

CREATE TRIGGER IF NOT EXISTS si_active_pinned
BEFORE UPDATE OF state ON search_index_builds
WHEN OLD.state = 'ready' AND NEW.state <> 'ready'
  AND EXISTS (SELECT 1 FROM search_index_active WHERE build_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'the active build cannot leave ready'); END;

CREATE TRIGGER IF NOT EXISTS si_kind_immutable
BEFORE UPDATE OF kind ON search_index_builds
WHEN NEW.kind <> OLD.kind
BEGIN SELECT RAISE(ABORT, 'a build kind is immutable'); END;
```

`IS NOT` rather than `<>` so a dangling `build_id` aborts instead of passing on NULL
(the FK catches it too; both are cheap). `ON DELETE RESTRICT` stops a delete of the
live build. No partial unique index on `state='ready'`: it would forbid the second
build while the first still serves — the HLS lesson.

`asset_watermark` / `segment_watermark` are per corpus on purpose. A single
`max(rowid)` across two tables under-reports when the lower table grows, which is the
exact signal the panel needs.

## Store — `packages/database/src/search-index.ts` (new)

```ts
export type SearchIndexKind = 'fts' | 'faiss'
export type SearchIndexBuildState = 'building' | 'ready' | 'superseded' | 'failed'
export type SearchIndexBuildSource = 'bootstrap' | 'operator' | 'boot-repair'

export interface SearchIndexIdentity {
  modelSha256: string | null
  pipelineVersion: string | null
  dimensions: number | null
}

export interface SearchIndexCounts {
  assets: number
  segments: number
  assetWatermark: number
  segmentWatermark: number
}

export interface SearchIndexBuildRecord {
  id: string
  kind: SearchIndexKind
  state: SearchIndexBuildState
  source: SearchIndexBuildSource
  counts: SearchIndexCounts
  identity: SearchIndexIdentity
  startedAt: number
  finishedAt: number | null
  verifiedAt: number | null
  supersededAt: number | null
  lastError: string | null
}

export function startSearchIndexBuild(
  db: Db,
  input: { kind: SearchIndexKind; source: SearchIndexBuildSource; identity?: SearchIndexIdentity; now: number },
): SearchIndexBuildRecord

/** building -> ready. Throws when the row is not building. */
export function finishSearchIndexBuild(db: Db, id: string, counts: SearchIndexCounts, now: number): void

/** -> failed. No-op unless the row is still building, so an active row can never be failed. */
export function failSearchIndexBuild(db: Db, id: string, message: string, now: number): void

/** Pointer upsert, then supersede the outgoing row. Order is load-bearing: the
 *  si_active_pinned trigger only permits the demotion after the pointer has moved. */
export function activateSearchIndexBuild(db: Db, id: string, now: number): void

export function getSearchIndexBuild(db: Db, id: string): SearchIndexBuildRecord | null
export function getActiveSearchIndexBuild(db: Db, kind: SearchIndexKind): SearchIndexBuildRecord | null
export function listSearchIndexBuilds(db: Db, kind: SearchIndexKind, limit: number): SearchIndexBuildRecord[]

/** building rows older than maxAgeMs -> failed with 'the process that started this build did not finish it'. */
export function failStaleSearchIndexBuilds(db: Db, now: number, maxAgeMs: number): number

export function listSearchIndexGcCandidates(db: Db, now: number, retentionMs: number): SearchIndexBuildRecord[]

/** Same predicate as the candidates, re-checked inside the DELETE. */
export function deleteSearchIndexBuilds(db: Db, now: number, retentionMs: number): number
```

GC predicate, in both functions:

```sql
state IN ('superseded','failed')
AND coalesce(finished_at, started_at) < :now - :retentionMs
AND NOT EXISTS (SELECT 1 FROM search_index_active a WHERE a.build_id = search_index_builds.id)
```

`deleteSearchIndexBuilds` returns the count. No preview token and no 409: the DELETE
re-checks every condition, so a stale preview cannot delete anything it should not.
That is the deliberate difference from `cleanCache`.

`id` is `crypto.randomUUID()`? **No** — the host's web origin is not a secure context,
but this runs in Bun on the server, where `crypto.randomUUID()` is available. Use
`randomUUID` from `node:crypto` for consistency with the rest of the server code; check
what the neighbouring stores do and follow them.

## FTS lifecycle — `packages/database/src/search-fts.ts`

```ts
export type SearchFtsMode = 'adopted' | 'bootstrapped' | 'repaired' | 'off'

export interface SearchFtsStatus {
  enabled: boolean
  mode: SearchFtsMode
  reason: string | null
  buildId: string | null
  assets: number
  segments: number
  rebuiltMs: number
  verifyMs: number
}

export function configureSearchFts(db: Db, enabled: boolean): SearchFtsStatus   // signature kept
export function rebuildSearchIndex(db: Db): SearchIndexBuildRecord              // operator path; throws
export function searchFtsReady(db: Db): boolean                                 // existing
export function searchFtsArmed(db: Db): boolean                                 // six triggers present
export function searchFtsIntact(db: Db): boolean                                // both vtabs are 'fts'
export function disarmSearchFts(db: Db): void                                   // ready.delete(db)
```

Signature is kept as `(db, boolean)` because 1 API boot site, 1 bench script and 13
test call sites use it. Do not switch to an options object.

### `publishFtsBuild(db, source, now)` — one private path

1. `startSearchIndexBuild(db, { kind: 'fts', source, now })` — **committed before the
   rebuild**. A `building` row must survive a rollback, or the failure record and the
   stale reaper both have nothing to act on.
2. One `db.transaction`:
   - `rebuild(db, table)` for both `INDEXES`
   - `verifyIndex(db, table)` for both; on a non-null failure throw
   - `finishSearchIndexBuild(db, id, counts(db), now)`
   - `activateSearchIndexBuild(db, id, now)`
3. On throw: `failSearchIndexBuild(db, id, message, now)` outside the transaction, then
   rethrow. The rollback restored the previous index content and the pointer never
   moved, so the previously active build keeps serving.

`counts(db)` = `indexedRows(db,'asset_search')`, `indexedRows(db,'segment_search')`,
`max(rowid)` of `assets` and of `transcript_segments` (`coalesce(...,0)`).

### `configureSearchFts` decision tree

```
enabled=false:
  drop the six triggers in a transaction (existing behaviour)
  disarmSearchFts(db)
  return { enabled:false, mode:'off', reason:'disabled by configuration', buildId:null, ...0 }
  // No build row. A boot that never attempted a build is not a failed build, and a
  // row per boot is unbounded growth on a host that deliberately runs FTS off.

enabled=true:
  create vtabs + triggers (existing block, unchanged; 'foreign' throws -> off)
  failStaleSearchIndexBuilds(db, now, 10 * 60_000)
  active = getActiveSearchIndexBuild(db, 'fts')
  verify both tables (timed)
  verify passes:
    active exists -> arm; mode 'adopted', buildId = active.id
    no active    -> start + finish + activate a 'bootstrap' build; arm; mode 'bootstrapped'
  verify fails:
    publishFtsBuild(db, 'boot-repair', now)
      success -> arm; mode 'repaired'
      throw   -> disarm; mode 'off', reason = message
```

Boot must **not** rebuild unconditionally. Today's flow already verifies first and
rebuilds only on failure; preserve that, or every boot creates a build row and pays a
full rebuild.

`arm` means `ready.add(db)`.

## Search path — `packages/database/src/search.ts`

The FTS branch can throw when the vtab is swapped out from under a ready process
(`countSegmentMatches` / the `MATCH` query). Today that escapes
`routes/scenes.ts:166-170` and 500s the whole request, including the filename leg that
would otherwise answer.

In both `searchDialogue` and `searchAssetNames`, wrap the condition and the FTS query:

```ts
if (phrase !== null && searchFtsReady(db)) {
  try {
    if (countSegmentMatches(db, phrase, ceiling + 1) <= ceiling) {
      return db.query(/* FTS */).all(...)
    }
  } catch (error) {
    recordFtsQueryFailure(table, error)
    if (!searchFtsIntact(db)) disarmSearchFts(db)
  }
}
return db.query(/* LIKE oracle */).all(...)
```

`recordFtsQueryFailure` keeps a module-local
`{ at: number; message: string } | null` exposed as `lastSearchFtsQueryFailure()`. It is
process-local, like `processReady`, and the status labels it as such. Disarm only on a
structural failure (`searchFtsIntact` false), not on a transient `SQLITE_BUSY`, or one
busy moment would cost LIKE search until restart.

The LIKE branch stays outside the `try`: a genuine database failure still surfaces.

## API — `apps/api/src/search-index.ts` (new), `apps/api/src/routes/search-index.ts` (new)

```ts
export interface SearchIndexStatus {
  kind: 'fts'
  active: SearchIndexBuildRecord | null
  processReady: boolean
  triggersArmed: boolean
  intact: boolean
  fallback: 'fts' | 'like-fallback' | 'unavailable'
  live: SearchIndexCounts | null       // null when !intact
  rowsSinceBuild: { assets: number; segments: number } | null
  lastQueryFailure: { at: number; message: string } | null
  recent: SearchIndexBuildRecord[]
}

export function readSearchIndexStatus(ctx: AppContext): SearchIndexStatus
export function rebuildSearchIndexNow(ctx: AppContext): SearchIndexBuildRecord
```

`fallback`: `!intact` -> `unavailable`; `processReady && triggersArmed && active` ->
`fts`; else `like-fallback`. The three values distinguish a fault from a
configuration state; the panel renders the matrix (`processReady` x `triggersArmed` x
`intact`) rather than collapsing it.

`readSearchIndexStatus` runs one deferred read transaction over the pointer, the
`sqlite_master` trigger probe and the `_docsize` counts. It **never** runs
`integrity-check`: that is an `INSERT` (`search-fts.ts:225`) which takes a write lock,
and diagnostics polls every 30 s. `verifiedAt` on the row is the verify evidence.

`rebuildSearchIndexNow` holds a module-level `rebuildInFlight` boolean and throws
`RebuildInFlightError` before touching SQLite. On success `ready.add(db)` — the route
runs on `ctx.db`, the same handle `searchDialogue` reads, which is why the rebuild is
here and not in a worker. On failure it does **not** disarm unless
`!searchFtsIntact(db)`.

Routes (system namespace, matching `/api/system/diagnostics`):

| method | path | result |
| --- | --- | --- |
| GET | `/api/system/search-index` | `{ status, builds }` |
| POST | `/api/system/search-index/rebuild` | 201 build; 409 `rebuild_in_flight`; 500 masked with `diagnosticId` |
| GET | `/api/system/search-index/gc/preview` | `{ builds, total }` |
| POST | `/api/system/search-index/gc` | `{ deleted }` |

Follow the auth preHandler used by `routes/diagnostics.ts`.

## Shared types — `packages/shared/src/domain.ts`

`SearchIndexBuildDTO`, `SearchIndexStatusDTO`, `SearchIndexGcPreviewDTO`; add
`searchIndex: SearchIndexStatusDTO` to `DiagnosticsReportDTO`. No `JobKind` change, no
`CACHE_TYPES` change, no `CapabilitiesDTO` change, no `SEARCH_FAISS_ENABLED`.

## Diagnostics — `apps/api/src/diagnostics.ts`, `apps/api/src/routes/diagnostics.ts`

Embed the status in the report and add a `## Search index` markdown section: mode,
active build id (8 chars), source, age from `verifiedAt`, documents, watermark,
`rowsSinceBuild`, `triggersArmed`, `processReady`, `fallback`, `lastError`, recent
builds. Root redaction already applies; nothing new to redact.

## Web

- `apps/web/src/pages/DiagnosticsPage.tsx`: a `<Section title="검색 색인">` after "캐시".
  Shows the matrix as three badges, the active build, documents/watermark/rows since,
  recent builds, a rebuild button with confirm, and a GC preview dialog listing the
  rows to delete. Copy says build, never 세대.
- `apps/web/src/pages/SearchPage.tsx:94-99`: drop the false index claim. The empty
  state currently says the scene index may be unbuilt for every query, including pure
  text queries. Replace the body with `"다른 낱말이나 더 짧은 낱말로 찾아보세요."`

## Constants

```ts
export const SEARCH_BUILD_STALE_MS = 10 * 60_000        // a 'building' row older than this is orphaned
export const SEARCH_BUILD_RETENTION_MS = 30 * 24 * 60 * 60_000
```

## Tests

`packages/database/src/v26.test.ts`
1. Fresh DB and replay-from-v25 upgrade: `SCHEMA_VERSION === 26`, both tables, four
   triggers, `integrity_check`, `foreign_key_check` empty.
2. Two sequential publishes: exactly one pointer row, the old row `superseded`, the new
   one active.
3. Trigger refusals: activate a `building` row; activate a `failed` row; kind mismatch;
   demote the active row; `UPDATE ... SET kind`; `DELETE` the active build row.
4. **Failed rebuild keeps the old index**: build #1 active, `PRAGMA query_only = 1`,
   `rebuildSearchIndex` throws, clear the pragma, then assert build #1 is still active,
   its `state` is `ready`, and `searchDialogue` returns the same rows as before.
5. Idempotent backfill: rebuild twice -> same counts, same watermarks, identical
   `searchDialogue` / `searchAssetNames` results, two build rows, one active.
6. GC: a `superseded` row inside the retention window survives; past it, it is deleted;
   an active row and a `building` row are never candidates.

`packages/database/src/search-fts.test.ts` (extend)
7. `configureSearchFts(db, true)` on an existing verified index adopts it
   (`mode:'adopted'`, no new row); on a missing row it bootstraps exactly one; after a
   trigger-less write it repairs and the old row is superseded.
8. `configureSearchFts(db, false)` leaves no new build row, `searchFtsArmed` false,
   `searchFtsIntact` true.

`packages/database/src/search.test.ts` (new or extend)
9. With `ready` true, replace `segment_search` with a plain table:
   `searchDialogue` returns LIKE results instead of throwing,
   `lastSearchFtsQueryFailure()` is non-null, `searchFtsReady` false.

`apps/api/src/search-index.test.ts` (new)
10. Status: `fallback` in all three states; `rowsSinceBuild` grows after a trigger-less
    insert; `live` null when the table is foreign; `processReady` false after disarm.
11. Concurrent rebuild -> 409; a failed rebuild -> 500 with a `diagnosticId` and the old
    build still active.
12. Diagnostics report embeds the section and the markdown renders it.

## Files

`packages/database/src/schema.ts` (v26), `search-index.ts` (new), `search-fts.ts`,
`search.ts`, `index.ts`; `packages/shared/src/domain.ts`;
`apps/api/src/search-index.ts` (new), `routes/search-index.ts` (new), `app.ts`,
`index.ts`, `diagnostics.ts`, `routes/diagnostics.ts`;
`apps/web/src/pages/DiagnosticsPage.tsx`, `SearchPage.tsx`;
tests as above. No worker, no compose, no config, no cache-inventory change.

## Rejected, with reasons

| candidate idea | why not |
| --- | --- |
| Worker job + adopt-on-poll (B) | A new `JobKind` touches `LANE_STATES`, `pipelineOf`, four media/maintenance queries and ETA history, and the API still re-verifies at boot — the same work as A, plus a lane. |
| `manifest.json` + `CURRENT` + `<cache>/search-index/` (A, B) | FTS has no file artifact; the index is the vtab. Grep shows no writer for that path. Pure ceremony now, real for FAISS later. |
| `search_fts_state` table (B) | A second persisted `triggers_armed` fact that can drift from `sqlite_master`. The live probe is one cheap query and cannot lie. |
| `seq` fence + CAS (B) | The rebuild is serialized by the write lock and the process mutex; there is no second builder to fence. |
| `deleting`/`removed` two-phase GC (A, B) | Two-phase exists because an unlink can fail. A row delete either commits or does not. |
| `search-index` in `CACHE_TYPES` (A, B) | Nothing on disk to count; it would add a permanent zero-byte row. |
| `SEARCH_FAISS_ENABLED` flag (A, B) | A flag with no behaviour is a diagnostics lie. |
| A failed build row on every disabled boot (A addendum) | Unbounded growth on a host that runs FTS off. The disarmed window is already visible: triggers absent + active build + watermark lag. |
| Per-leg path marker on the search response (ops addendum) | Needs a persisted counter to be useful to a panel; the status already names the state. The catch-and-fallback is the correctness half and is included. |

## Open risks

- The rebuild blocks the API event loop for its duration. At 14.5k assets and ~15k
  segments the FTS5 rebuild is expected well under a second, but this is an estimate,
  not a measurement. The first host rehearsal must time it, and if it exceeds ~2 s the
  route needs 202 + poll even though the work stays in-process.
- The transactional-rebuild assumption (`INSERT ... VALUES('rebuild')` rolls back
  cleanly) is inference until test 4 runs.
- `PRAGMA query_only` may not block an FTS5 internal write the way it blocks a table
  write. If it does not, test 4 needs another deterministic failure (a `BEFORE INSERT`
  trigger cannot be added to a vtab; a read-only file handle is the fallback).
