import type { SQLQueryBindings } from 'bun:sqlite'
import { newId, type PlaylistKind } from '@mediavault/shared'
import { ASSET_COLUMNS, hydrateAssets } from './assets'
import type { Db } from './db'
import type { AssetRecord, AssetRow } from './types'

type Params = SQLQueryBindings[]

export interface PlaylistRecord {
  id: string
  userId: string
  name: string
  description: string | null
  kind: PlaylistKind
  /** Every item row, including the ones whose asset is gone. */
  itemCount: number
  availableCount: number
  createdAt: number
  updatedAt: number
}

export interface PlaylistItemRecord {
  id: string
  assetId: string
  position: number
  addedAt: number
  /** False when the asset was soft-deleted. The item row survives it. */
  available: boolean
}

export type PlaylistWriteResult =
  | { kind: 'ok'; playlist: PlaylistRecord }
  | { kind: 'name_taken' }
  | { kind: 'missing' }

export type PlaylistItemWriteResult =
  | { kind: 'ok'; item: PlaylistItemRecord }
  | { kind: 'missing' }
  | { kind: 'asset_missing' }

interface PlaylistRow {
  id: string
  userId: string
  name: string
  description: string | null
  kind: string
  itemCount: number
  availableCount: number
  createdAt: number
  updatedAt: number
}

interface PlaylistItemRow {
  id: string
  assetId: string
  position: number
  addedAt: number
  available: number
}

const COLUMNS = `
  p.id, p.user_id AS userId, p.name, p.description, p.kind,
  (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id) AS itemCount,
  (SELECT COUNT(*) FROM playlist_items pi
     JOIN assets a ON a.id = pi.asset_id
    WHERE pi.playlist_id = p.id AND a.deleted_at IS NULL) AS availableCount,
  p.created_at AS createdAt, p.updated_at AS updatedAt
`

/** Every read of a playlist's items shares this order, so positions cannot disagree. */
const ITEM_ORDER = 'pi.position ASC, pi.added_at ASC, pi.id ASC'

function toRecord(row: PlaylistRow): PlaylistRecord {
  return { ...row, kind: row.kind === 'watch_later' ? 'watch_later' : 'custom' }
}

function toItemRecord(row: PlaylistItemRow): PlaylistItemRecord {
  return { ...row, available: row.available === 1 }
}

/**
 * SQLite reports a violated unique index by its columns, not its name, so the
 * two indexes on `playlists` are told apart by whether `name` is among them.
 */
function uniqueCollision(error: unknown): 'name' | 'watch_later' | null {
  if (!(error instanceof Error) || !error.message.includes('UNIQUE constraint failed')) return null
  return error.message.includes('playlists.name') ? 'name' : 'watch_later'
}

export interface NewPlaylist {
  userId: string
  name: string
  description: string | null
  kind: PlaylistKind
  now: number
}

/**
 * A watch-later insert that loses the race with another one returns the list
 * that won, so a caller never has to distinguish "created" from "already there".
 */
export function createPlaylist(db: Db, input: NewPlaylist): PlaylistWriteResult {
  const name = input.name.trim()
  if (!name) throw new Error('Playlist name cannot be empty')
  const id = newId()
  try {
    db.query<null, Params>(
      `INSERT INTO playlists (id, user_id, name, description, kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.userId, name, input.description, input.kind, input.now, input.now)
  } catch (error) {
    const collision = uniqueCollision(error)
    if (collision === null) throw error
    if (collision === 'watch_later') {
      const existing = readWatchLater(db, input.userId)
      if (existing) return { kind: 'ok', playlist: existing }
    }
    return { kind: 'name_taken' }
  }
  return {
    kind: 'ok',
    playlist: {
      id,
      userId: input.userId,
      name,
      description: input.description,
      kind: input.kind,
      itemCount: 0,
      availableCount: 0,
      createdAt: input.now,
      updatedAt: input.now,
    },
  }
}

export interface PlaylistPatch {
  name?: string
  description?: string | null
}

export function updatePlaylist(
  db: Db,
  id: string,
  userId: string,
  patch: PlaylistPatch,
  now: number,
): PlaylistWriteResult {
  const sets: string[] = []
  const params: Params = []
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) throw new Error('Playlist name cannot be empty')
    sets.push('name = ?')
    params.push(name)
  }
  if (patch.description !== undefined) {
    sets.push('description = ?')
    params.push(patch.description)
  }
  if (sets.length === 0) {
    const playlist = getPlaylist(db, id, userId)
    return playlist ? { kind: 'ok', playlist } : { kind: 'missing' }
  }

  let updated: { id: string } | null
  try {
    updated = db
      .query<{ id: string }, Params>(
        `UPDATE playlists SET ${sets.join(', ')}, updated_at = ?
         WHERE id = ? AND user_id = ?
         RETURNING id`,
      )
      .get(...params, now, id, userId)
  } catch (error) {
    if (uniqueCollision(error) !== null) return { kind: 'name_taken' }
    throw error
  }
  if (!updated) return { kind: 'missing' }
  const playlist = getPlaylist(db, id, userId)
  return playlist ? { kind: 'ok', playlist } : { kind: 'missing' }
}

export function getPlaylist(db: Db, id: string, userId: string): PlaylistRecord | null {
  const row = db
    .query<PlaylistRow, Params>(`SELECT ${COLUMNS} FROM playlists p WHERE p.id = ? AND p.user_id = ?`)
    .get(id, userId)
  return row ? toRecord(row) : null
}

/** The watch-later list first, then the most recently changed. */
export function listPlaylists(db: Db, userId: string): PlaylistRecord[] {
  return db
    .query<PlaylistRow, Params>(
      `SELECT ${COLUMNS} FROM playlists p
       WHERE p.user_id = ?
       ORDER BY (p.kind = 'watch_later') DESC, p.updated_at DESC, p.id DESC`,
    )
    .all(userId)
    .map(toRecord)
}

export function deletePlaylist(db: Db, id: string, userId: string): boolean {
  const removed = db
    .query<{ id: string }, Params>('DELETE FROM playlists WHERE id = ? AND user_id = ? RETURNING id')
    .get(id, userId)
  return removed !== null
}

const WATCH_LATER_NAME = '나중에 보기'
const WATCH_LATER_NAME_ATTEMPTS = 20

function readWatchLater(db: Db, userId: string): PlaylistRecord | null {
  const row = db
    .query<PlaylistRow, Params>(
      `SELECT ${COLUMNS} FROM playlists p WHERE p.user_id = ? AND p.kind = 'watch_later'`,
    )
    .get(userId)
  return row ? toRecord(row) : null
}

/**
 * The default list, created on first use. A custom playlist may already hold the
 * default name, and a name is unique per user, so the fallback names keep the
 * promise that a caller always gets a watch-later list back.
 */
export function ensureWatchLater(db: Db, userId: string, now: number): PlaylistRecord {
  const existing = readWatchLater(db, userId)
  if (existing) return existing
  for (let attempt = 0; attempt < WATCH_LATER_NAME_ATTEMPTS; attempt += 1) {
    const name = attempt === 0 ? WATCH_LATER_NAME : `${WATCH_LATER_NAME} ${attempt + 1}`
    const created = createPlaylist(db, { userId, name, description: null, kind: 'watch_later', now })
    if (created.kind === 'ok') return created.playlist
  }
  throw new Error('Could not create the watch later list')
}

export interface NewPlaylistItem {
  playlistId: string
  userId: string
  assetId: string
  now: number
}

/**
 * Appends one asset. The same asset may sit in a list more than once, so the
 * position is the identity of a slot, not the asset.
 */
export function addPlaylistItem(db: Db, input: NewPlaylistItem): PlaylistItemWriteResult {
  return db
    .transaction((): PlaylistItemWriteResult => {
      const owned = db
        .query<{ id: string }, Params>('SELECT id FROM playlists WHERE id = ? AND user_id = ?')
        .get(input.playlistId, input.userId)
      if (!owned) return { kind: 'missing' }
      const asset = db
        .query<{ id: string }, Params>('SELECT id FROM assets WHERE id = ? AND deleted_at IS NULL')
        .get(input.assetId)
      if (!asset) return { kind: 'asset_missing' }

      const position =
        db
          .query<{ position: number }, Params>(
            'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM playlist_items WHERE playlist_id = ?',
          )
          .get(input.playlistId)?.position ?? 0
      const id = newId()
      db.query<null, Params>(
        'INSERT INTO playlist_items (id, playlist_id, asset_id, position, added_at) VALUES (?, ?, ?, ?, ?)',
      ).run(id, input.playlistId, input.assetId, position, input.now)
      touchPlaylist(db, input.playlistId, input.now)
      return { kind: 'ok', item: { id, assetId: input.assetId, position, addedAt: input.now, available: true } }
    })
    .immediate()
}

/** `updated_at` tracks the list's contents, which is what the sidebar orders by. */
function touchPlaylist(db: Db, playlistId: string, now: number): void {
  db.query<null, Params>('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now, playlistId)
}

export function removePlaylistItem(db: Db, playlistId: string, itemId: string, userId: string): boolean {
  return db
    .transaction(() => {
      const owned = db
        .query<{ id: string }, Params>('SELECT id FROM playlists WHERE id = ? AND user_id = ?')
        .get(playlistId, userId)
      if (!owned) return false
      const removed = db
        .query<{ id: string }, Params>('DELETE FROM playlist_items WHERE id = ? AND playlist_id = ? RETURNING id')
        .get(itemId, playlistId)
      if (!removed) return false
      touchPlaylist(db, playlistId, Date.now())
      return true
    })
    .immediate()
}

/**
 * Moves one item to `position` and rewrites every position as its new index, so
 * the stored order stays dense and two items can never share a position.
 */
export function movePlaylistItem(
  db: Db,
  playlistId: string,
  itemId: string,
  position: number,
  userId: string,
): boolean {
  return db
    .transaction(() => {
      const owned = db
        .query<{ id: string }, Params>('SELECT id FROM playlists WHERE id = ? AND user_id = ?')
        .get(playlistId, userId)
      if (!owned) return false

      const ids = db
        .query<{ id: string }, Params>(
          `SELECT pi.id FROM playlist_items pi WHERE pi.playlist_id = ? ORDER BY ${ITEM_ORDER}`,
        )
        .all(playlistId)
        .map((row) => row.id)
      const from = ids.indexOf(itemId)
      if (from === -1) return false

      ids.splice(from, 1)
      const target = Math.min(Math.max(Math.trunc(position), 0), ids.length)
      ids.splice(target, 0, itemId)

      const statement = db.query<null, Params>('UPDATE playlist_items SET position = ? WHERE id = ?')
      for (const [index, id] of ids.entries()) statement.run(index, id)
      touchPlaylist(db, playlistId, Date.now())
      return true
    })
    .immediate()
}

export function listPlaylistItems(db: Db, playlistId: string, userId: string): PlaylistItemRecord[] {
  return db
    .query<PlaylistItemRow, Params>(
      `SELECT pi.id, pi.asset_id AS assetId, pi.position, pi.added_at AS addedAt,
              (a.id IS NOT NULL AND a.deleted_at IS NULL) AS available
       FROM playlist_items pi
       JOIN playlists p ON p.id = pi.playlist_id
       LEFT JOIN assets a ON a.id = pi.asset_id
       WHERE pi.playlist_id = ? AND p.user_id = ?
       ORDER BY ${ITEM_ORDER}`,
    )
    .all(playlistId, userId)
    .map(toItemRecord)
}

/** The playable items in order. A soft-deleted asset is skipped, not reordered. */
export function listPlaylistAssets(db: Db, playlistId: string, userId: string): AssetRecord[] {
  const rows = db
    .query<AssetRow, Params>(
      `SELECT ${ASSET_COLUMNS}
       FROM playlist_items pi
       JOIN playlists p ON p.id = pi.playlist_id
       JOIN assets a ON a.id = pi.asset_id AND a.deleted_at IS NULL
       WHERE pi.playlist_id = ? AND p.user_id = ?
       ORDER BY ${ITEM_ORDER}`,
    )
    .all(playlistId, userId)
  return hydrateAssets(db, rows)
}
