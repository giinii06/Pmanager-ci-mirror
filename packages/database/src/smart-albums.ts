import type { SQLQueryBindings } from 'bun:sqlite'
import {
  newId,
  parseFilterTree,
  VIDEO_SORTS,
  type FilterTree,
  type SmartAlbumFilter,
  type VideoSort,
} from '@mediavault/shared'
import type { Db } from './db'

type Params = SQLQueryBindings[]

export interface SmartAlbumRecord {
  id: string
  userId: string
  name: string
  description: string | null
  filter: SmartAlbumFilter
  sort: VideoSort | null
  pinned: boolean
  createdAt: number
  updatedAt: number
}

export type SmartAlbumWriteResult =
  | { kind: 'ok'; album: SmartAlbumRecord }
  | { kind: 'name_taken' }
  | { kind: 'missing' }

interface AlbumRow {
  id: string
  userId: string
  name: string
  description: string | null
  filterJson: string
  sort: string | null
  pinned: number
  createdAt: number
  updatedAt: number
}

const COLUMNS = `
  id, user_id AS userId, name, description, filter_json AS filterJson, sort,
  pinned, created_at AS createdAt, updated_at AS updatedAt
`

function readFilter(filterJson: string): SmartAlbumFilter {
  let stored: unknown
  try {
    stored = JSON.parse(filterJson)
  } catch {
    return { valid: false, error: 'the stored filter is not JSON' }
  }
  const parsed = parseFilterTree(stored)
  return parsed.ok ? { valid: true, tree: parsed.tree } : { valid: false, error: parsed.error }
}

function readSort(sort: string | null): VideoSort | null {
  return sort !== null && (VIDEO_SORTS as readonly string[]).includes(sort) ? (sort as VideoSort) : null
}

function toRecord(row: AlbumRow): SmartAlbumRecord {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    description: row.description,
    filter: readFilter(row.filterJson),
    sort: readSort(row.sort),
    pinned: row.pinned === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function isNameTaken(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed')
}

export interface NewSmartAlbum {
  userId: string
  name: string
  description: string | null
  filter: FilterTree
  sort: VideoSort | null
  pinned: boolean
  now: number
}

export function createSmartAlbum(db: Db, input: NewSmartAlbum): SmartAlbumWriteResult {
  const name = input.name.trim()
  if (!name) throw new Error('Smart album name cannot be empty')
  const id = newId()
  try {
    db.query<null, Params>(
      `INSERT INTO smart_albums (
         id, user_id, name, description, filter_version, filter_json, sort, pinned, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.userId,
      name,
      input.description,
      JSON.stringify(input.filter),
      input.sort,
      input.pinned ? 1 : 0,
      input.now,
      input.now,
    )
  } catch (error) {
    if (isNameTaken(error)) return { kind: 'name_taken' }
    throw error
  }
  return {
    kind: 'ok',
    album: {
      id,
      userId: input.userId,
      name,
      description: input.description,
      filter: { valid: true, tree: input.filter },
      sort: input.sort,
      pinned: input.pinned,
      createdAt: input.now,
      updatedAt: input.now,
    },
  }
}

export interface SmartAlbumPatch {
  name?: string
  description?: string | null
  filter?: FilterTree
  sort?: VideoSort | null
  pinned?: boolean
}

export function updateSmartAlbum(
  db: Db,
  id: string,
  userId: string,
  patch: SmartAlbumPatch,
  now: number,
): SmartAlbumWriteResult {
  const sets: string[] = []
  const params: Params = []
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) throw new Error('Smart album name cannot be empty')
    sets.push('name = ?')
    params.push(name)
  }
  if (patch.description !== undefined) {
    sets.push('description = ?')
    params.push(patch.description)
  }
  if (patch.filter !== undefined) {
    sets.push('filter_version = 1', 'filter_json = ?')
    params.push(JSON.stringify(patch.filter))
  }
  if (patch.sort !== undefined) {
    sets.push('sort = ?')
    params.push(patch.sort)
  }
  if (patch.pinned !== undefined) {
    sets.push('pinned = ?')
    params.push(patch.pinned ? 1 : 0)
  }
  if (sets.length === 0) {
    const album = getSmartAlbum(db, id, userId)
    return album ? { kind: 'ok', album } : { kind: 'missing' }
  }

  let updated: { id: string } | null
  try {
    updated = db
      .query<{ id: string }, Params>(
        `UPDATE smart_albums SET ${sets.join(', ')}, updated_at = ?
         WHERE id = ? AND user_id = ?
         RETURNING id`,
      )
      .get(...params, now, id, userId)
  } catch (error) {
    if (isNameTaken(error)) return { kind: 'name_taken' }
    throw error
  }
  if (!updated) return { kind: 'missing' }
  const album = getSmartAlbum(db, id, userId)
  return album ? { kind: 'ok', album } : { kind: 'missing' }
}

export function getSmartAlbum(db: Db, id: string, userId: string): SmartAlbumRecord | null {
  const row = db
    .query<AlbumRow, Params>(`SELECT ${COLUMNS} FROM smart_albums WHERE id = ? AND user_id = ?`)
    .get(id, userId)
  return row ? toRecord(row) : null
}

/** Pinned albums first, then the one edited most recently. */
export function listSmartAlbums(db: Db, userId: string): SmartAlbumRecord[] {
  return db
    .query<AlbumRow, Params>(
      `SELECT ${COLUMNS} FROM smart_albums
       WHERE user_id = ?
       ORDER BY pinned DESC, updated_at DESC, id DESC`,
    )
    .all(userId)
    .map(toRecord)
}

export function deleteSmartAlbum(db: Db, id: string, userId: string): boolean {
  const removed = db
    .query<{ id: string }, Params>(
      'DELETE FROM smart_albums WHERE id = ? AND user_id = ? RETURNING id',
    )
    .get(id, userId)
  return removed !== null
}
