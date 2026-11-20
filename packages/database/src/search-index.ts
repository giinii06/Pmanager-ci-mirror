import type { SQLQueryBindings } from 'bun:sqlite'
import { newId } from '@mediavault/shared'
import type { Db } from './db'

type Params = SQLQueryBindings[]

export type SearchIndexKind = 'fts' | 'faiss'
export type SearchIndexBuildState = 'building' | 'ready' | 'superseded' | 'failed'
export type SearchIndexBuildSource = 'bootstrap' | 'operator' | 'boot-repair'

/** A 'building' row older than this was abandoned by the process that started it. */
export const SEARCH_BUILD_STALE_MS = 10 * 60_000
export const SEARCH_BUILD_RETENTION_MS = 30 * 24 * 60 * 60_000

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

interface BuildRow {
  id: string
  kind: SearchIndexKind
  state: SearchIndexBuildState
  source: SearchIndexBuildSource
  assets: number
  segments: number
  assetWatermark: number
  segmentWatermark: number
  modelSha256: string | null
  pipelineVersion: string | null
  dimensions: number | null
  startedAt: number
  finishedAt: number | null
  verifiedAt: number | null
  supersededAt: number | null
  lastError: string | null
}

const buildColumns = (prefix = ''): string => `${prefix}id, ${prefix}kind, ${prefix}state, ${prefix}source,
  ${prefix}assets_count AS assets, ${prefix}segments_count AS segments,
  ${prefix}asset_watermark AS assetWatermark, ${prefix}segment_watermark AS segmentWatermark,
  ${prefix}model_sha256 AS modelSha256, ${prefix}pipeline_version AS pipelineVersion,
  ${prefix}dimensions, ${prefix}started_at AS startedAt, ${prefix}finished_at AS finishedAt,
  ${prefix}verified_at AS verifiedAt, ${prefix}superseded_at AS supersededAt,
  ${prefix}last_error AS lastError`

function toRecord(row: BuildRow): SearchIndexBuildRecord {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    source: row.source,
    counts: {
      assets: row.assets,
      segments: row.segments,
      assetWatermark: row.assetWatermark,
      segmentWatermark: row.segmentWatermark,
    },
    identity: {
      modelSha256: row.modelSha256,
      pipelineVersion: row.pipelineVersion,
      dimensions: row.dimensions,
    },
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    verifiedAt: row.verifiedAt,
    supersededAt: row.supersededAt,
    lastError: row.lastError,
  }
}

/**
 * The row is written and committed before any index work begins, so a rebuild
 * that rolls back still leaves the failure behind for the panel and the reaper.
 */
export function startSearchIndexBuild(
  db: Db,
  input: {
    kind: SearchIndexKind
    source: SearchIndexBuildSource
    identity?: SearchIndexIdentity
    now: number
  },
): SearchIndexBuildRecord {
  const id = newId(16)
  const identity = input.identity ?? { modelSha256: null, pipelineVersion: null, dimensions: null }
  db.query<null, Params>(
    `INSERT INTO search_index_builds (
       id, kind, state, source, model_sha256, pipeline_version, dimensions, started_at
     ) VALUES (?, ?, 'building', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.kind,
    input.source,
    identity.modelSha256,
    identity.pipelineVersion,
    identity.dimensions,
    input.now,
  )
  return getSearchIndexBuild(db, id)!
}

/** building -> ready. Throws when the row is not building. */
export function finishSearchIndexBuild(
  db: Db,
  id: string,
  counts: SearchIndexCounts,
  now: number,
): void {
  const changes = db
    .query<null, Params>(
      `UPDATE search_index_builds
       SET state = 'ready', assets_count = ?, segments_count = ?,
           asset_watermark = ?, segment_watermark = ?,
           finished_at = ?, verified_at = ?
       WHERE id = ? AND state = 'building'`,
    )
    .run(
      counts.assets,
      counts.segments,
      counts.assetWatermark,
      counts.segmentWatermark,
      now,
      now,
      id,
    ).changes
  if (changes === 0) throw new Error(`search index build ${id} is not building`)
}

/** No-op unless the row is still building, so an active row can never be failed. */
export function failSearchIndexBuild(db: Db, id: string, message: string, now: number): void {
  db.query<null, Params>(
    `UPDATE search_index_builds
     SET state = 'failed', last_error = ?, finished_at = ?
     WHERE id = ? AND state = 'building'`,
  ).run(message, now, id)
}

/**
 * Pointer upsert, then supersede the outgoing row. The order is load-bearing:
 * `si_active_pinned` only permits the demotion once the pointer has moved.
 */
export function activateSearchIndexBuild(db: Db, id: string, now: number): void {
  const build = getSearchIndexBuild(db, id)
  if (!build) throw new Error(`search index build ${id} does not exist`)

  db.transaction(() => {
    const outgoing = db
      .query<{ buildId: string }, [SearchIndexKind]>(
        'SELECT build_id AS buildId FROM search_index_active WHERE kind = ?',
      )
      .get(build.kind)
    db.query<null, Params>(
      `INSERT INTO search_index_active (kind, build_id, activated_at) VALUES (?, ?, ?)
       ON CONFLICT(kind) DO UPDATE
       SET build_id = excluded.build_id, activated_at = excluded.activated_at`,
    ).run(build.kind, id, now)
    if (outgoing && outgoing.buildId !== id) {
      db.query<null, Params>(
        `UPDATE search_index_builds SET state = 'superseded', superseded_at = ?
         WHERE id = ? AND state = 'ready'`,
      ).run(now, outgoing.buildId)
    }
  })()
}

export function getSearchIndexBuild(db: Db, id: string): SearchIndexBuildRecord | null {
  const row = db
    .query<BuildRow, [string]>(`SELECT ${buildColumns()} FROM search_index_builds WHERE id = ?`)
    .get(id)
  return row ? toRecord(row) : null
}

export function getActiveSearchIndexBuild(
  db: Db,
  kind: SearchIndexKind,
): SearchIndexBuildRecord | null {
  const row = db
    .query<BuildRow, [SearchIndexKind]>(
      `SELECT ${buildColumns('b.')}
       FROM search_index_active a
       JOIN search_index_builds b ON b.id = a.build_id
       WHERE a.kind = ?`,
    )
    .get(kind)
  return row ? toRecord(row) : null
}

export function listSearchIndexBuilds(
  db: Db,
  kind: SearchIndexKind,
  limit: number,
): SearchIndexBuildRecord[] {
  return db
    .query<BuildRow, [SearchIndexKind, number]>(
      `SELECT ${buildColumns()} FROM search_index_builds
       WHERE kind = ? ORDER BY started_at DESC, id DESC LIMIT ?`,
    )
    .all(kind, limit)
    .map(toRecord)
}

/**
 * A build row that is still 'building' outlived the process that started it.
 * Every boot reaps them, so a crash mid-rebuild does not leave a row that looks
 * like work in progress forever.
 */
export function failStaleSearchIndexBuilds(db: Db, now: number, maxAgeMs: number): number {
  return db
    .query<null, Params>(
      `UPDATE search_index_builds
       SET state = 'failed',
           last_error = 'the process that started this build did not finish it',
           finished_at = ?
       WHERE state = 'building' AND started_at < ?`,
    )
    .run(now, now - maxAgeMs).changes
}

/** Never the active row, never a building one, and never one inside the window. */
const GC_PREDICATE = `state IN ('superseded','failed')
  AND coalesce(finished_at, started_at) < ?
  AND NOT EXISTS (SELECT 1 FROM search_index_active a WHERE a.build_id = search_index_builds.id)`

export function listSearchIndexGcCandidates(
  db: Db,
  now: number,
  retentionMs: number,
): SearchIndexBuildRecord[] {
  return db
    .query<BuildRow, [number]>(
      `SELECT ${buildColumns()} FROM search_index_builds
       WHERE ${GC_PREDICATE} ORDER BY started_at DESC`,
    )
    .all(now - retentionMs)
    .map(toRecord)
}

/** Same predicate as the candidates, re-checked inside the DELETE. */
export function deleteSearchIndexBuilds(db: Db, now: number, retentionMs: number): number {
  return db
    .query<null, [number]>(
      `DELETE FROM search_index_builds WHERE ${GC_PREDICATE}`,
    )
    .run(now - retentionMs).changes
}

/**
 * What a build of `kind` would cover right now. `count(*)` on an
 * external-content FTS table reads the content table, so the document counts
 * come from the `%_docsize` shadow table, which holds one row per indexed
 * document. The watermarks are per corpus: one shared maximum would hide the
 * smaller table growing.
 */
export function searchIndexCounts(db: Db): SearchIndexCounts {
  return {
    assets: indexedDocuments(db, 'asset_search'),
    segments: indexedDocuments(db, 'segment_search'),
    assetWatermark: watermark(db, 'assets'),
    segmentWatermark: watermark(db, 'transcript_segments'),
  }
}

function indexedDocuments(db: Db, table: string): number {
  try {
    return db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}_docsize`).get()?.n ?? 0
  } catch {
    return 0
  }
}

function watermark(db: Db, table: string): number {
  return db.query<{ n: number }, []>(`SELECT coalesce(max(rowid), 0) AS n FROM ${table}`).get()?.n ?? 0
}
