import type { SQLQueryBindings } from 'bun:sqlite'
import type { AssetKind, StatsDTO } from '@mediavault/shared'
import type { Db } from './db'
import type { AssetFileInfo, AssetRecord, AssetRow, ScanAssetRow } from './types'

type Params = SQLQueryBindings[]

export interface AssetFilter {
  libraryId?: string
  folderId?: string
  kind?: AssetKind
  favoriteOnly?: boolean
  query?: string
}

export interface TimelineCursor {
  takenAt: number
  id: string
}

const COLUMNS = `
  a.id, a.library_id AS libraryId, a.folder_id AS folderId, a.relative_path AS relativePath,
  a.filename, a.kind, a.mime_type AS mimeType, a.size_bytes AS sizeBytes, a.mtime_ms AS mtimeMs,
  a.width, a.height, a.duration_ms AS durationMs, a.taken_at AS takenAt, a.file_version AS fileVersion,
  a.video_codec AS videoCodec, a.audio_codec AS audioCodec, a.container
`

function mapAsset(row: AssetRow): AssetRecord {
  return { ...row, favorite: row.favorite === 1 }
}

function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
}

function buildWhere(
  filter: AssetFilter,
  cursor: TimelineCursor | null,
  userId: string,
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
  if (filter.favoriteOnly) {
    clauses.push('EXISTS (SELECT 1 FROM favorites f WHERE f.asset_id = a.id AND f.user_id = ?)')
    params.push(userId)
  }
  if (filter.query) {
    clauses.push("a.filename LIKE ? ESCAPE '\\'")
    params.push(likePattern(filter.query))
  }
  if (cursor) {
    clauses.push('(a.taken_at < ? OR (a.taken_at = ? AND a.id < ?))')
    params.push(cursor.takenAt, cursor.takenAt, cursor.id)
  }
  return { sql: clauses.join(' AND '), params }
}

export function listAssets(
  db: Db,
  userId: string,
  filter: AssetFilter,
  cursor: TimelineCursor | null,
  limit: number,
): { records: AssetRecord[]; total: number; hasMore: boolean } {
  const where = buildWhere(filter, cursor, userId)
  const rows = db
    .query<AssetRow, Params>(
      `SELECT ${COLUMNS},
        EXISTS (SELECT 1 FROM favorites f WHERE f.asset_id = a.id AND f.user_id = ?) AS favorite
       FROM assets a
       WHERE ${where.sql}
       ORDER BY a.taken_at DESC, a.id DESC
       LIMIT ?`,
    )
    .all(userId, ...where.params, limit + 1)

  const countWhere = buildWhere(filter, null, userId)
  const total =
    db
      .query<{ n: number }, Params>(`SELECT COUNT(*) AS n FROM assets a WHERE ${countWhere.sql}`)
      .get(...countWhere.params)?.n ?? 0

  const hasMore = rows.length > limit
  return { records: rows.slice(0, limit).map(mapAsset), total, hasMore }
}

export function getAsset(db: Db, userId: string, id: string): AssetRecord | null {
  const row = db
    .query<AssetRow, Params>(
      `SELECT ${COLUMNS},
        EXISTS (SELECT 1 FROM favorites f WHERE f.asset_id = a.id AND f.user_id = ?) AS favorite
       FROM assets a
       WHERE a.id = ? AND a.deleted_at IS NULL`,
    )
    .get(userId, id)
  return row ? mapAsset(row) : null
}

/** Same folder first, then the rest of the library. No similarity model. */
export function relatedAssets(
  db: Db,
  userId: string,
  assetId: string,
  limit: number,
): AssetRecord[] {
  const rows = db
    .query<AssetRow, Params>(
      `SELECT ${COLUMNS},
        EXISTS (SELECT 1 FROM favorites f WHERE f.asset_id = a.id AND f.user_id = ?) AS favorite
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
    .all(userId, assetId, limit)
  return rows.map(mapAsset)
}

/**
 * Hydrates the given ids. A caller that ranked them keeps its own order, so the
 * rows come back unordered and the caller re-sorts.
 */
export function assetsByIds(db: Db, userId: string, ids: string[]): AssetRecord[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db
    .query<AssetRow, Params>(
      `SELECT ${COLUMNS},
        EXISTS (SELECT 1 FROM favorites f WHERE f.asset_id = a.id AND f.user_id = ?) AS favorite
       FROM assets a
       WHERE a.id IN (${placeholders}) AND a.deleted_at IS NULL`,
    )
    .all(userId, ...ids)
  return rows.map(mapAsset)
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

export function updateAssetFile(db: Db, id: string, update: AssetFileUpdate): void {
  db.query<null, Params>(
    `UPDATE assets SET
       folder_id = ?, filename = ?, mime_type = ?, size_bytes = ?, mtime_ms = ?,
       width = ?, height = ?, duration_ms = ?, taken_at = ?,
       video_codec = ?, audio_codec = ?, container = ?, indexed_at = ?,
       file_version = file_version + 1, deleted_at = NULL, last_seen_scan = ?
     WHERE id = ?`,
  ).run(
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
}

export function touchAsset(db: Db, id: string, scanId: string): void {
  db.query<null, Params>(
    'UPDATE assets SET last_seen_scan = ?, deleted_at = NULL WHERE id = ?',
  ).run(scanId, id)
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

/**
 * The videos an index pass may enqueue work for. A file with no duration has no
 * windows and no frames to sample, so it is skipped until a scan fills it in.
 */
export function listVideosForIndexing(
  db: Db,
  limit: number,
): Array<{ id: string; fileVersion: number }> {
  return db
    .query<{ id: string; fileVersion: number }, Params>(
      `SELECT id, file_version AS fileVersion FROM assets
       WHERE deleted_at IS NULL AND kind = 'video' AND duration_ms IS NOT NULL
       ORDER BY id ASC LIMIT ?`,
    )
    .all(limit)
}

export function getStats(db: Db, userId: string): StatsDTO {
  const counts =
    db
      .query<{ assets: number; images: number; videos: number }, Params>(
        `SELECT COUNT(*) AS assets,
                COALESCE(SUM(kind = 'image'), 0) AS images,
                COALESCE(SUM(kind = 'video'), 0) AS videos
         FROM assets WHERE deleted_at IS NULL`,
      )
      .get() ?? { assets: 0, images: 0, videos: 0 }
  const favorites =
    db
      .query<{ n: number }, Params>(
        'SELECT COUNT(*) AS n FROM favorites f JOIN assets a ON a.id = f.asset_id WHERE f.user_id = ? AND a.deleted_at IS NULL',
      )
      .get(userId)?.n ?? 0
  const libraries = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM libraries').get()?.n ?? 0
  const folders = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM folders').get()?.n ?? 0
  return { ...counts, favorites, libraries, folders }
}

export function addFavorite(db: Db, userId: string, assetId: string, now: number): void {
  db.query<null, Params>(
    `INSERT INTO favorites (user_id, asset_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id, asset_id) DO NOTHING`,
  ).run(userId, assetId, now)
}

export function removeFavorite(db: Db, userId: string, assetId: string): void {
  db.query<null, Params>('DELETE FROM favorites WHERE user_id = ? AND asset_id = ?').run(
    userId,
    assetId,
  )
}
