import type { SQLQueryBindings } from 'bun:sqlite'
import { newId } from '@mediavault/shared'
import type { Db } from './db'

type Params = SQLQueryBindings[]

export const BOOKMARK_TITLE_MAX = 120
export const BOOKMARK_NOTE_MAX = 2000

/** A bookmark may sit a second past the recorded duration; a real player rounds. */
const DURATION_TOLERANCE_MS = 1000

export interface VideoBookmarkRecord {
  id: string
  userId: string
  assetId: string
  positionMs: number
  title: string | null
  note: string | null
  /** The asset's version when the mark was made. A later version makes it stale. */
  fileVersion: number
  stale: boolean
  createdAt: number
  updatedAt: number
}

export type BookmarkWriteResult =
  | { kind: 'ok'; bookmark: VideoBookmarkRecord }
  | { kind: 'missing' }
  | { kind: 'asset_missing' }
  | { kind: 'out_of_range'; durationMs: number | null }

interface BookmarkRow {
  id: string
  userId: string
  assetId: string
  positionMs: number
  title: string | null
  note: string | null
  fileVersion: number
  stale: number
  createdAt: number
  updatedAt: number
}

const COLUMNS = `
  b.id, b.user_id AS userId, b.asset_id AS assetId, b.position_ms AS positionMs,
  b.title, b.note, b.file_version AS fileVersion,
  (a.file_version IS NOT NULL AND a.file_version <> b.file_version) AS stale,
  b.created_at AS createdAt, b.updated_at AS updatedAt
`

function toRecord(row: BookmarkRow): VideoBookmarkRecord {
  return { ...row, stale: row.stale === 1 }
}

/** An absent field and a field that is only whitespace are the same thing to a reader. */
function normaliseText(value: string | null | undefined, max: number, label: string): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  if (trimmed.length > max) throw new Error(`${label} cannot exceed ${max} characters`)
  return trimmed === '' ? null : trimmed
}

interface AssetTiming {
  fileVersion: number
  durationMs: number | null
}

function readAssetTiming(db: Db, assetId: string): AssetTiming | null {
  return (
    db
      .query<AssetTiming, Params>(
        `SELECT file_version AS fileVersion, duration_ms AS durationMs
         FROM assets WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(assetId) ?? null
  )
}

function pastDuration(positionMs: number, durationMs: number | null): boolean {
  return durationMs !== null && positionMs > durationMs + DURATION_TOLERANCE_MS
}

export interface NewBookmark {
  userId: string
  assetId: string
  positionMs: number
  title: string | null
  note: string | null
  now: number
}

export function createBookmark(db: Db, input: NewBookmark): BookmarkWriteResult {
  const title = normaliseText(input.title, BOOKMARK_TITLE_MAX, 'Bookmark title')
  const note = normaliseText(input.note, BOOKMARK_NOTE_MAX, 'Bookmark note')

  const asset = readAssetTiming(db, input.assetId)
  if (!asset) return { kind: 'asset_missing' }
  if (!Number.isInteger(input.positionMs) || input.positionMs < 0 || pastDuration(input.positionMs, asset.durationMs)) {
    return { kind: 'out_of_range', durationMs: asset.durationMs }
  }

  const id = newId()
  db.query<null, Params>(
    `INSERT INTO video_bookmarks (id, user_id, asset_id, position_ms, title, note, file_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.userId, input.assetId, input.positionMs, title, note, asset.fileVersion, input.now, input.now)

  return {
    kind: 'ok',
    bookmark: {
      id,
      userId: input.userId,
      assetId: input.assetId,
      positionMs: input.positionMs,
      title,
      note,
      fileVersion: asset.fileVersion,
      stale: false,
      createdAt: input.now,
      updatedAt: input.now,
    },
  }
}

export interface BookmarkPatch {
  positionMs?: number
  title?: string | null
  note?: string | null
}

/**
 * The stored `file_version` is never rewritten here. A mark left at a timestamp
 * of a file that changed stays stale until the user places a new one, which is
 * the only way the new timestamp is known to still mean anything.
 */
export function updateBookmark(
  db: Db,
  id: string,
  userId: string,
  patch: BookmarkPatch,
  now: number,
): BookmarkWriteResult {
  const current = db
    .query<{ assetId: string }, Params>('SELECT asset_id AS assetId FROM video_bookmarks WHERE id = ? AND user_id = ?')
    .get(id, userId)
  if (!current) return { kind: 'missing' }

  const sets: string[] = []
  const params: Params = []
  if (patch.positionMs !== undefined) {
    const asset = readAssetTiming(db, current.assetId)
    const durationMs = asset?.durationMs ?? null
    if (!Number.isInteger(patch.positionMs) || patch.positionMs < 0 || pastDuration(patch.positionMs, durationMs)) {
      return { kind: 'out_of_range', durationMs }
    }
    sets.push('position_ms = ?')
    params.push(patch.positionMs)
  }
  if (patch.title !== undefined) {
    sets.push('title = ?')
    params.push(normaliseText(patch.title, BOOKMARK_TITLE_MAX, 'Bookmark title'))
  }
  if (patch.note !== undefined) {
    sets.push('note = ?')
    params.push(normaliseText(patch.note, BOOKMARK_NOTE_MAX, 'Bookmark note'))
  }

  if (sets.length > 0) {
    db.query<null, Params>(
      `UPDATE video_bookmarks SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND user_id = ?`,
    ).run(...params, now, id, userId)
  }

  const bookmark = getBookmark(db, id, userId)
  return bookmark ? { kind: 'ok', bookmark } : { kind: 'missing' }
}

export function getBookmark(db: Db, id: string, userId: string): VideoBookmarkRecord | null {
  const row = db
    .query<BookmarkRow, Params>(
      `SELECT ${COLUMNS} FROM video_bookmarks b
       LEFT JOIN assets a ON a.id = b.asset_id
       WHERE b.id = ? AND b.user_id = ?`,
    )
    .get(id, userId)
  return row ? toRecord(row) : null
}

/** Earliest first, which is the order a chapter list reads in. */
export function listBookmarks(db: Db, userId: string, assetId: string): VideoBookmarkRecord[] {
  return db
    .query<BookmarkRow, Params>(
      `SELECT ${COLUMNS} FROM video_bookmarks b
       LEFT JOIN assets a ON a.id = b.asset_id
       WHERE b.user_id = ? AND b.asset_id = ?
       ORDER BY b.position_ms ASC, b.created_at ASC, b.id ASC`,
    )
    .all(userId, assetId)
    .map(toRecord)
}

export function deleteBookmark(db: Db, id: string, userId: string): boolean {
  const removed = db
    .query<{ id: string }, Params>('DELETE FROM video_bookmarks WHERE id = ? AND user_id = ? RETURNING id')
    .get(id, userId)
  return removed !== null
}
