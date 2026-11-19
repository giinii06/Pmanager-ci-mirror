import type { SQLQueryBindings } from 'bun:sqlite'
import type { AssetKind, StatsDTO, VideoSort } from '@mediavault/shared'
import { newId } from '@mediavault/shared'
import { deleteAssetVoteEvents, recordVoteEvent } from './contributions'
import type { Db } from './db'
import { likePattern, RATE_RANKED_SQL, type CompiledFilter } from './filter'
import { recomputeFolderCounts } from './folders'
import { listTagsForAssets } from './tags'
import type { AssetFileInfo, AssetRecord, AssetRow, ScanAssetRow } from './types'

type Params = SQLQueryBindings[]

export interface AssetFilter {
  libraryId?: string
  folderId?: string
  kind?: AssetKind
  tagId?: string
  sort?: VideoSort
  seed?: number
  query?: string
  /** A compiled filter tree. The caller compiles once and shares it with the count. */
  where?: CompiledFilter
}

export interface TimelineCursor {
  takenAt: number
  id: string
}

export interface OffsetCursor {
  offset: number
}

export type AssetCursor = TimelineCursor | OffsetCursor

/** Callers outside this module must alias `assets` as `a`, as every query here does. */
export const ASSET_COLUMNS = `
  a.id, a.library_id AS libraryId, a.folder_id AS folderId, a.relative_path AS relativePath,
  a.filename, a.kind, a.mime_type AS mimeType, a.size_bytes AS sizeBytes, a.mtime_ms AS mtimeMs,
  a.width, a.height, a.duration_ms AS durationMs, a.taken_at AS takenAt, a.file_version AS fileVersion,
  a.video_codec AS videoCodec, a.audio_codec AS audioCodec, a.container,
  a.view_count AS viewCount, a.watch_time_ms AS watchTimeMs,
  a.vote_count AS voteCount, a.poster_version AS posterVersion
`

const SEEDED_ORDER_SQL = `
  (((((a.rowid + unicode(substr(a.id, 1, 1)) * 131)
      * (1103515245 + (? % 65521) * 48271)
      + (? % 2147483646)) % 2147483647)
    * (16807 + (a.rowid % 97) * 131)) % 2147483647)
`

function isTimelineCursor(cursor: AssetCursor | null): cursor is TimelineCursor {
  return cursor !== null && 'takenAt' in cursor && 'id' in cursor
}

export function resolveAssetSort(filter: Pick<AssetFilter, 'sort' | 'kind'>): VideoSort {
  if (filter.sort) return filter.sort
  return filter.kind === 'video' ? 'rate' : 'latest'
}

/**
 * Computes relative watch-time percentile scores (0..100) for rated videos.
 * Videos with zero views or zero watch time are excluded and map to `null`.
 */
export function computeAssetRates(db: Db, assetIds: string[]): Map<string, number> {
  const rates = new Map<string, number>()
  if (assetIds.length === 0) return rates
  const placeholders = assetIds.map(() => '?').join(', ')
  const rows = db
    .query<{ id: string; rate: number }, Params>(
      `${RATE_RANKED_SQL}
       SELECT id, rate FROM ranked WHERE id IN (${placeholders})`,
    )
    .all(...assetIds)
  for (const row of rows) rates.set(row.id, row.rate)
  return rates
}

/** Adds tags and watch-time rates to rows a caller already selected. */
export function hydrateAssets(db: Db, rows: AssetRow[]): AssetRecord[] {
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const tagsByAsset = listTagsForAssets(db, ids)
  const ratedCandidateIds = rows
    .filter((row) => row.kind === 'video' && row.viewCount > 0 && row.watchTimeMs > 0)
    .map((row) => row.id)
  const ratesByAsset = computeAssetRates(db, ratedCandidateIds)
  return rows.map((row) => ({
    ...row,
    rate: ratesByAsset.get(row.id) ?? null,
    tags: tagsByAsset.get(row.id) ?? [],
  }))
}

function buildWhere(
  filter: AssetFilter,
  cursor: TimelineCursor | null,
): { sql: string; params: Params } {
  const clauses: string[] = ['a.deleted_at IS NULL']
  const params: Params = []
  if (filter.libraryId) {
    clauses.push('a.library_id = ?')
    params.push(filter.libraryId)
  }
  if (filter.folderId) {
    clauses.push('a.folder_id = ?')
    params.push(filter.folderId)
  }
  if (filter.kind) {
    clauses.push('a.kind = ?')
    params.push(filter.kind)
  }
  if (filter.tagId) {
    clauses.push('EXISTS (SELECT 1 FROM asset_tags at WHERE at.asset_id = a.id AND at.tag_id = ?)')
    params.push(filter.tagId)
  }
  if (filter.query) {
    clauses.push("a.filename LIKE ? ESCAPE '\\'")
    params.push(likePattern(filter.query))
  }
  if (filter.where) {
    clauses.push(`(${filter.where.sql})`)
    params.push(...filter.where.params)
  }
  if (cursor) {
    clauses.push('(a.taken_at < ? OR (a.taken_at = ? AND a.id < ?))')
    params.push(cursor.takenAt, cursor.takenAt, cursor.id)
  }
  return { sql: clauses.join(' AND '), params }
}

function buildOrderExpression(sort: VideoSort, seed: number): { expr: string; params: Params } {
  const safeSeed = Math.abs(Math.trunc(seed)) % 2147483647
  switch (sort) {
    case 'rate':
      return {
        expr: `CASE WHEN a.view_count > 0 AND a.watch_time_ms > 0 THEN 0 ELSE 1 END ASC,
          CASE WHEN a.view_count > 0 AND a.watch_time_ms > 0
            THEN CAST(a.watch_time_ms AS REAL) / a.view_count
            ELSE 0 END DESC,
          CASE WHEN a.view_count > 0 AND a.watch_time_ms > 0 THEN a.watch_time_ms ELSE 0 END DESC,
          CASE WHEN a.view_count > 0 AND a.watch_time_ms > 0 THEN a.view_count ELSE 0 END DESC,
          CASE WHEN a.view_count > 0 AND a.watch_time_ms > 0 THEN 0 ELSE ${SEEDED_ORDER_SQL} END ASC,
          a.taken_at DESC,
          a.id DESC`,
        params: [safeSeed, safeSeed],
      }
    case 'views':
      return {
        expr: 'a.view_count DESC, a.watch_time_ms DESC, a.taken_at DESC, a.id DESC',
        params: [],
      }
    case 'watch_time':
      return {
        expr: 'a.watch_time_ms DESC, a.view_count DESC, a.taken_at DESC, a.id DESC',
        params: [],
      }
    case 'votes':
      return {
        expr: 'a.vote_count DESC, a.view_count DESC, a.taken_at DESC, a.id DESC',
        params: [],
      }
    case 'name':
      return {
        expr: 'a.filename COLLATE NOCASE ASC, a.id ASC',
        params: [],
      }
    case 'latest':
      return {
        expr: 'a.taken_at DESC, a.id DESC',
        params: [],
      }
  }
}

function buildOrder(sort: VideoSort, seed: number): { sql: string; params: Params } {
  const order = buildOrderExpression(sort, seed)
  return { sql: `ORDER BY ${order.expr}`, params: order.params }
}

export function listAssets(
  db: Db,
  filter: AssetFilter,
  cursor: AssetCursor | null,
  limit: number,
): { records: AssetRecord[]; total: number; hasMore: boolean } {
  const sort = resolveAssetSort(filter)
  const timelineCursor = sort === 'latest' && isTimelineCursor(cursor) ? cursor : null
  const offset = cursor && 'offset' in cursor ? Math.max(0, cursor.offset) : 0
  const where = buildWhere(filter, timelineCursor)
  const order = buildOrder(sort, filter.seed ?? 1)

  const rows = db
    .query<AssetRow, Params>(
      `SELECT ${ASSET_COLUMNS}
       FROM assets a
       WHERE ${where.sql}
       ${order.sql}
       LIMIT ? OFFSET ?`,
    )
    .all(...where.params, ...order.params, limit + 1, offset)

  const countWhere = buildWhere(filter, null)
  const total =
    db
      .query<{ n: number }, Params>(`SELECT COUNT(*) AS n FROM assets a WHERE ${countWhere.sql}`)
      .get(...countWhere.params)?.n ?? 0

  const hasMore = rows.length > limit
  return { records: hydrateAssets(db, rows.slice(0, limit)), total, hasMore }
}

export function listMatchingAssetIds(db: Db, filter: AssetFilter, limit = 10_000): string[] {
  const sort = resolveAssetSort(filter)
  const where = buildWhere(filter, null)
  const order = buildOrder(sort, filter.seed ?? 1)
  return db
    .query<{ id: string }, Params>(
      `SELECT a.id FROM assets a WHERE ${where.sql} ${order.sql} LIMIT ?`,
    )
    .all(...where.params, ...order.params, limit)
    .map((row) => row.id)
}

export type AssetNeighborResult =
  | { kind: 'ok'; record: AssetRecord | null }
  | { kind: 'missing' }
  | { kind: 'outside_filter' }

/**
 * Resolves the asset directly before or after `id` in the same order
 * `listAssets` returns. The order and filter SQL are shared, so a sort change
 * cannot make the viewer and the grid disagree; the final `id` tie-breaker in
 * every order makes the rank unique.
 */
export function getAssetNeighbor(
  db: Db,
  id: string,
  filter: AssetFilter,
  direction: 'next' | 'prev',
): AssetNeighborResult {
  const where = buildWhere(filter, null)
  const anchor = db
    .query<{ id: string }, Params>(`SELECT a.id FROM assets a WHERE a.id = ? AND ${where.sql}`)
    .get(id, ...where.params)
  if (!anchor) {
    const exists = db
      .query<{ id: string }, Params>('SELECT id FROM assets WHERE id = ? AND deleted_at IS NULL')
      .get(id)
    return exists ? { kind: 'outside_filter' } : { kind: 'missing' }
  }

  const order = buildOrderExpression(resolveAssetSort(filter), filter.seed ?? 1)
  const delta = direction === 'next' ? 1 : -1
  const row = db
    .query<{ id: string }, Params>(
      `WITH filtered AS (
         SELECT a.rowid AS rowid, a.* FROM assets a WHERE ${where.sql}
       ),
       ranked AS (
         SELECT a.id, ROW_NUMBER() OVER (ORDER BY ${order.expr}) AS rn
         FROM filtered a
       ),
       anchor AS (SELECT rn FROM ranked WHERE id = ?)
       SELECT r.id
       FROM ranked r, anchor
       WHERE r.rn = anchor.rn + ?
       LIMIT 1`,
    )
    .get(...where.params, ...order.params, id, delta)

  return { kind: 'ok', record: row ? getAsset(db, row.id) : null }
}

function randomOffset(total: number): number {
  if (total <= 1) return 0
  const buffer = new Uint32Array(1)
  if (total > 0xffff_ffff) {
    crypto.getRandomValues(buffer)
    return buffer[0]! % total
  }
  const limit = Math.floor(0x1_0000_0000 / total) * total
  for (;;) {
    crypto.getRandomValues(buffer)
    const value = buffer[0]!
    if (value < limit) return value % total
  }
}

function seededOffset(total: number, seed: number): number {
  let x = (seed >>> 0) ^ 0x9e3779b9
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad)
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97)
  x = (x ^ (x >>> 15)) >>> 0
  return x % total
}

/**
 * Picks one asset uniformly from the filter's membership. The current asset and
 * the recent list are excluded while any other candidate exists, and the
 * recent list is relaxed before the pick fails, so a small pool still navigates.
 */
export function pickRandomAsset(
  db: Db,
  filter: AssetFilter,
  options: { currentAssetId?: string | null; recentIds?: readonly string[]; seed?: number } = {},
): AssetRecord | null {
  const where = buildWhere(filter, null)
  const current = options.currentAssetId ?? null
  const recent: string[] = []
  for (const id of options.recentIds ?? []) {
    if (id === current || recent.includes(id) || recent.length >= 32) continue
    recent.push(id)
  }

  const pick = (exclude: string[]): AssetRecord | null => {
    const clauses = [where.sql]
    const params: Params = [...where.params]
    if (exclude.length > 0) {
      clauses.push(`a.id NOT IN (${exclude.map(() => '?').join(', ')})`)
      params.push(...exclude)
    }
    const sql = clauses.join(' AND ')
    return db.transaction((): AssetRecord | null => {
      const total =
        db.query<{ n: number }, Params>(`SELECT COUNT(*) AS n FROM assets a WHERE ${sql}`).get(...params)?.n ?? 0
      if (total === 0) return null
      const offset = options.seed === undefined ? randomOffset(total) : seededOffset(total, options.seed)
      const row = db
        .query<{ id: string }, Params>(
          `SELECT a.id FROM assets a WHERE ${sql} ORDER BY a.id ASC LIMIT 1 OFFSET ?`,
        )
        .get(...params, offset)
      return row ? getAsset(db, row.id) : null
    })()
  }

  const picked = pick(current ? [current, ...recent] : recent)
  if (picked || recent.length === 0) return picked
  return pick(current ? [current] : [])
}

export function getAsset(db: Db, id: string): AssetRecord | null {
  const row = db
    .query<AssetRow, Params>(
      `SELECT ${ASSET_COLUMNS}
       FROM assets a
       WHERE a.id = ? AND a.deleted_at IS NULL`,
    )
    .get(id)
  if (!row) return null
  return hydrateAssets(db, [row])[0] ?? null
}

/** Same folder first, then the rest of the library. No similarity model. */
export function relatedAssets(db: Db, assetId: string, limit: number): AssetRecord[] {
  const rows = db
    .query<AssetRow, Params>(
      `SELECT ${ASSET_COLUMNS}
       FROM assets a
       JOIN assets current ON current.id = ?
       WHERE a.id != current.id
         AND a.kind = 'video'
         AND a.library_id = current.library_id
         AND a.deleted_at IS NULL
       ORDER BY CASE WHEN a.folder_id IS current.folder_id THEN 0 ELSE 1 END,
                a.taken_at DESC, a.id DESC
       LIMIT ?`,
    )
    .all(assetId, limit)
  return hydrateAssets(db, rows)
}

/**
 * Hydrates the given ids. A caller that ranked them keeps its own order, so the
 * rows come back unordered and the caller re-sorts.
 */
export function assetsByIds(db: Db, ids: string[]): AssetRecord[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db
    .query<AssetRow, Params>(
      `SELECT ${ASSET_COLUMNS}
       FROM assets a
       WHERE a.id IN (${placeholders}) AND a.deleted_at IS NULL`,
    )
    .all(...ids)
  return hydrateAssets(db, rows)
}

export function incrementAssetView(db: Db, id: string): AssetRecord | null {
  const res = db
    .query<null, Params>('UPDATE assets SET view_count = view_count + 1 WHERE id = ? AND deleted_at IS NULL')
    .run(id)
  if (res.changes === 0) return null
  return getAsset(db, id)
}

export function addAssetWatchTime(db: Db, id: string, deltaMs: number): AssetRecord | null {
  const clamped = Math.max(0, Math.min(Math.round(deltaMs), 600_000))
  const res = db
    .query<null, Params>(
      'UPDATE assets SET watch_time_ms = watch_time_ms + ? WHERE id = ? AND deleted_at IS NULL',
    )
    .run(clamped, id)
  if (res.changes === 0) return null
  return getAsset(db, id)
}

/**
 * Every real click is its own vote. `clientRequestId` only makes a transport
 * retry of the same click idempotent; two clicks with different ids count twice.
 */
export function voteAsset(
  db: Db,
  id: string,
  now = Date.now(),
  clientRequestId?: string | null,
  actorId?: string | null,
): AssetRecord | null {
  let found = false
  db.transaction(() => {
    const row = db
      .query<{ filename: string }, Params>(
        'SELECT filename FROM assets WHERE id = ? AND deleted_at IS NULL',
      )
      .get(id)
    if (!row) return
    found = true
    const eventId = clientRequestId
      ? `client:asset:${actorId ?? 'anonymous'}:${id}:${clientRequestId}`
      : newId()
    if (!recordVoteEvent(db, 'asset', id, row.filename, now, eventId)) return
    db.query<null, Params>('UPDATE assets SET vote_count = vote_count + 1 WHERE id = ?').run(id)
  }).immediate()
  if (!found) return null
  return getAsset(db, id)
}

export function bumpPosterVersion(
  db: Db,
  id: string,
  expectedFileVersion?: number,
): AssetRecord | null {
  const res =
    expectedFileVersion === undefined
      ? db
          .query<null, Params>(
            'UPDATE assets SET poster_version = poster_version + 1 WHERE id = ? AND deleted_at IS NULL',
          )
          .run(id)
      : db
          .query<null, Params>(
            `UPDATE assets SET poster_version = poster_version + 1
             WHERE id = ? AND deleted_at IS NULL AND file_version = ?`,
          )
          .run(id, expectedFileVersion)
  if (res.changes === 0) return null
  return getAsset(db, id)
}

export interface PermanentDeleteResult {
  deleted: boolean
  fileInfo: AssetFileInfo | null
  libraryRoot: string | null
  sceneThumbPaths: string[]
  asrResultDirs: string[]
  translationResultDirs: string[]
}

export function getAssetDeletePlan(db: Db, id: string): PermanentDeleteResult {
  const fileInfo = getAssetFileInfo(db, id)
  if (!fileInfo) {
    return {
      deleted: false,
      fileInfo: null,
      libraryRoot: null,
      sceneThumbPaths: [],
      asrResultDirs: [],
      translationResultDirs: [],
    }
  }

  const libraryRoot =
    db.query<{ rootPath: string }, Params>('SELECT root_path AS rootPath FROM libraries WHERE id = ?').get(fileInfo.libraryId)
      ?.rootPath ?? null

  const sceneThumbPaths = db
    .query<{ thumbnailPath: string }, Params>(
      'SELECT DISTINCT thumbnail_path AS thumbnailPath FROM video_scenes WHERE asset_id = ? AND thumbnail_path IS NOT NULL',
    )
    .all(id)
    .map((row) => row.thumbnailPath)

  const asrResultDirs = db
    .query<{ resultDir: string }, Params>('SELECT DISTINCT result_dir AS resultDir FROM transcripts WHERE asset_id = ?')
    .all(id)
    .map((row) => row.resultDir)

  const translationResultDirs = db
    .query<{ resultDir: string }, Params>('SELECT DISTINCT result_dir AS resultDir FROM translations WHERE asset_id = ?')
    .all(id)
    .map((row) => row.resultDir)

  return {
    deleted: true,
    fileInfo,
    libraryRoot,
    sceneThumbPaths,
    asrResultDirs,
    translationResultDirs,
  }
}

export function commitPermanentDelete(
  db: Db,
  id: string,
  libraryId: string,
  expectedMutationId?: string,
): boolean {
  const removed = db.transaction(() => {
    if (expectedMutationId !== undefined) {
      const owned = db
        .query<{ n: number }, Params>(
          'SELECT COUNT(*) AS n FROM assets WHERE id = ? AND pending_delete_mutation_id = ?',
        )
        .get(id, expectedMutationId)?.n
      if (owned !== 1) return false
    }
    deleteAssetVoteEvents(db, id)
    db.query<null, Params>('DELETE FROM jobs WHERE asset_id = ?').run(id)
    // `changes` counts rows the triggers wrote too, and the search index writes
    // two of them per deleted asset. RETURNING names the row that matched.
    const result = db
      .query<{ id: string }, Params>('DELETE FROM assets WHERE id = ? RETURNING id')
      .get(id)
    return result !== null
  }).immediate()
  if (removed) recomputeFolderCounts(db, libraryId)
  return removed
}

export function deleteAssetPermanently(db: Db, id: string): PermanentDeleteResult {
  const plan = getAssetDeletePlan(db, id)
  if (!plan.deleted || !plan.fileInfo) return plan
  commitPermanentDelete(db, id, plan.fileInfo.libraryId)
  return plan
}

export function getAssetFileInfo(db: Db, id: string): AssetFileInfo | null {
  return (
    db
      .query<AssetFileInfo, Params>(
        `SELECT id, library_id AS libraryId, folder_id AS folderId, relative_path AS relativePath,
                filename, kind, mime_type AS mimeType, file_version AS fileVersion,
                width, height, duration_ms AS durationMs, deleted_at AS deletedAt
         FROM assets WHERE id = ?`,
      )
      .get(id) ?? null
  )
}

export interface NewAsset {
  id: string
  libraryId: string
  folderId: string
  relativePath: string
  filename: string
  kind: AssetKind
  mimeType: string
  sizeBytes: number
  mtimeMs: number
  width: number | null
  height: number | null
  durationMs: number | null
  takenAt: number
  videoCodec: string | null
  audioCodec: string | null
  container: string | null
  indexedAt: number
  scanId: string
}

export function insertAsset(db: Db, asset: NewAsset): void {
  db.query<null, Params>(
    `INSERT INTO assets (
       id, library_id, folder_id, relative_path, filename, kind, mime_type, size_bytes, mtime_ms,
       width, height, duration_ms, taken_at, file_version, video_codec, audio_codec, container,
       indexed_at, last_seen_scan
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    asset.id,
    asset.libraryId,
    asset.folderId,
    asset.relativePath,
    asset.filename,
    asset.kind,
    asset.mimeType,
    asset.sizeBytes,
    asset.mtimeMs,
    asset.width,
    asset.height,
    asset.durationMs,
    asset.takenAt,
    asset.videoCodec,
    asset.audioCodec,
    asset.container,
    asset.indexedAt,
    asset.scanId,
  )
}

export function findAssetForScan(
  db: Db,
  libraryId: string,
  relativePath: string,
): ScanAssetRow | null {
  return (
    db
      .query<ScanAssetRow, Params>(
        `SELECT id, size_bytes AS sizeBytes, mtime_ms AS mtimeMs, file_version AS fileVersion,
                deleted_at AS deletedAt, last_seen_scan AS lastSeenScan
         FROM assets WHERE library_id = ? AND relative_path = ?`,
      )
      .get(libraryId, relativePath) ?? null
  )
}

export function preloadLibraryScanIndex(db: Db, libraryId: string): Map<string, ScanAssetRow> {
  const map = new Map<string, ScanAssetRow>()
  const rows = db
    .query<ScanAssetRow & { relativePath: string }, Params>(
      `SELECT relative_path AS relativePath, id, size_bytes AS sizeBytes, mtime_ms AS mtimeMs,
              file_version AS fileVersion, deleted_at AS deletedAt, last_seen_scan AS lastSeenScan
       FROM assets WHERE library_id = ?`,
    )
    .all(libraryId)
  for (const row of rows) {
    map.set(row.relativePath, {
      id: row.id,
      sizeBytes: row.sizeBytes,
      mtimeMs: row.mtimeMs,
      fileVersion: row.fileVersion,
      deletedAt: row.deletedAt,
      lastSeenScan: row.lastSeenScan,
    })
  }
  return map
}

export interface AssetFileUpdate {
  folderId: string
  filename: string
  mimeType: string
  sizeBytes: number
  mtimeMs: number
  width: number | null
  height: number | null
  durationMs: number | null
  takenAt: number
  videoCodec: string | null
  audioCodec: string | null
  container: string | null
  indexedAt: number
  scanId: string
}

export function updateAssetFile(db: Db, id: string, update: AssetFileUpdate): boolean {
  // `changes` counts rows the triggers wrote too, and renaming an asset updates
  // the search index. RETURNING names the row that matched.
  const result = db.query<{ id: string }, Params>(
    `UPDATE assets SET
       folder_id = ?, filename = ?, mime_type = ?, size_bytes = ?, mtime_ms = ?,
       width = ?, height = ?, duration_ms = ?, taken_at = ?,
       video_codec = ?, audio_codec = ?, container = ?, indexed_at = ?,
       file_version = file_version + 1, deleted_at = NULL, last_seen_scan = ?
     WHERE id = ? AND pending_delete_mutation_id IS NULL
     RETURNING id`,
  ).get(
    update.folderId,
    update.filename,
    update.mimeType,
    update.sizeBytes,
    update.mtimeMs,
    update.width,
    update.height,
    update.durationMs,
    update.takenAt,
    update.videoCodec,
    update.audioCodec,
    update.container,
    update.indexedAt,
    update.scanId,
    id,
  )
  return result !== null
}

/**
 * A delete mutation owns the asset's tombstone. Touching it here would clear
 * `deleted_at` and resurrect an asset whose file is already in quarantine.
 * Returns the ids that were actually touched.
 */
export function touchAssets(db: Db, ids: string[], scanId: string): Set<string> {
  const touched = new Set<string>()
  if (ids.length === 0) return touched
  const statement = db.query<null, Params>(
    'UPDATE assets SET last_seen_scan = ?, deleted_at = NULL WHERE id = ? AND pending_delete_mutation_id IS NULL',
  )
  db.transaction(() => {
    for (const id of ids) if (statement.run(scanId, id).changes === 1) touched.add(id)
  })()
  return touched
}

export function softDeleteMissing(db: Db, libraryId: string, scanId: string, now: number): number {
  const result = db
    .query<null, Params>(
      `UPDATE assets SET deleted_at = ?
       WHERE library_id = ? AND deleted_at IS NULL
         AND (last_seen_scan IS NULL OR last_seen_scan <> ?)`,
    )
    .run(now, libraryId, scanId)
  return result.changes
}

export function countAssets(db: Db, libraryId: string): number {
  return (
    db
      .query<{ n: number }, Params>(
        'SELECT COUNT(*) AS n FROM assets WHERE library_id = ? AND deleted_at IS NULL',
      )
      .get(libraryId)?.n ?? 0
  )
}

/** The rows a scan did not see, which `softDeleteMissing` would hide. */
export function countMissingAssets(db: Db, libraryId: string, scanId: string): number {
  return (
    db
      .query<{ n: number }, Params>(
        `SELECT COUNT(*) AS n FROM assets
         WHERE library_id = ? AND deleted_at IS NULL
           AND (last_seen_scan IS NULL OR last_seen_scan <> ?)`,
      )
      .get(libraryId, scanId)?.n ?? 0
  )
}

/**
 * The videos an index pass may enqueue work for. A file with no duration has no
 * windows and no frames to sample, so it is skipped until a scan fills it in.
 * `audioCodec` is null when the file has no audio stream, which is what keeps a
 * silent clip out of the transcription queue.
 */
export function listVideosForIndexingAfter(
  db: Db,
  afterId: string | null,
  limit: number,
): Array<{ id: string; fileVersion: number; audioCodec: string | null }> {
  if (limit <= 0) return []
  if (afterId === null) {
    return db
      .query<{ id: string; fileVersion: number; audioCodec: string | null }, Params>(
        `SELECT id, file_version AS fileVersion, audio_codec AS audioCodec FROM assets
         WHERE deleted_at IS NULL AND kind = 'video' AND duration_ms IS NOT NULL
         ORDER BY id ASC LIMIT ?`,
      )
      .all(limit)
  }
  return db
    .query<{ id: string; fileVersion: number; audioCodec: string | null }, Params>(
      `SELECT id, file_version AS fileVersion, audio_codec AS audioCodec FROM assets
       WHERE deleted_at IS NULL AND kind = 'video' AND duration_ms IS NOT NULL AND id > ?
       ORDER BY id ASC LIMIT ?`,
    )
    .all(afterId, limit)
}

export interface PipelineCursor {
  name: string
  lastId: string
  updatedAt: number
}

export function getPipelineCursor(db: Db, name: string): PipelineCursor | null {
  return (
    db
      .query<PipelineCursor, Params>(
        'SELECT name, last_id AS lastId, updated_at AS updatedAt FROM pipeline_cursors WHERE name = ?',
      )
      .get(name) ?? null
  )
}

export function setPipelineCursor(db: Db, name: string, lastId: string, now: number): void {
  db.query<null, Params>(
    `INSERT INTO pipeline_cursors (name, last_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET last_id = excluded.last_id, updated_at = excluded.updated_at`,
  ).run(name, lastId, now)
}

export function getStats(db: Db): StatsDTO {
  const counts =
    db
      .query<
        {
          assets: number
          images: number
          videos: number
          totalViews: number
          totalWatchTimeMs: number
          totalVotes: number
        },
        []
      >(
        `SELECT COUNT(*) AS assets,
                COALESCE(SUM(kind = 'image'), 0) AS images,
                COALESCE(SUM(kind = 'video'), 0) AS videos,
                COALESCE(SUM(view_count), 0) AS totalViews,
                COALESCE(SUM(watch_time_ms), 0) AS totalWatchTimeMs,
                COALESCE(SUM(vote_count), 0) AS totalVotes
         FROM assets WHERE deleted_at IS NULL`,
      )
      .get() ?? {
      assets: 0,
      images: 0,
      videos: 0,
      totalViews: 0,
      totalWatchTimeMs: 0,
      totalVotes: 0,
    }
  const libraries = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM libraries').get()?.n ?? 0
  const folders = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM folders').get()?.n ?? 0
  const tags = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM tags').get()?.n ?? 0
  return { ...counts, libraries, folders, tags }
}
