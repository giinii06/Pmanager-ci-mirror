import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { FilterTree } from '@mediavault/shared'
import {
  createSmartAlbum,
  createUser,
  deleteSmartAlbum,
  getSmartAlbum,
  listSmartAlbums,
  openDatabase,
  updateSmartAlbum,
  type Db,
} from './index'

const VIDEOS_OVER_1K: FilterTree = {
  version: 1,
  root: {
    type: 'and',
    children: [
      { type: 'cond', field: 'kind', operator: 'eq', value: 'video' },
      { type: 'cond', field: 'sizeBytes', operator: 'gt', value: 1000 },
    ],
  },
}

let db: Db

beforeEach(() => {
  db = openDatabase(':memory:')
  createUser(db, { id: 'u1', username: 'owner', passwordHash: 'h', createdAt: 1 })
  createUser(db, { id: 'u2', username: 'guest', passwordHash: 'h', createdAt: 1 })
})

afterEach(() => {
  db.close()
})

function create(userId: string, name: string, now = 100, filter = VIDEOS_OVER_1K) {
  return createSmartAlbum(db, {
    userId,
    name,
    description: null,
    filter,
    sort: null,
    pinned: false,
    now,
  })
}

describe('smart albums', () => {
  test('a saved album reads back with the exact filter it was given', () => {
    const created = create('u1', 'Big videos')
    expect(created.kind).toBe('ok')
    if (created.kind !== 'ok') return

    const stored = getSmartAlbum(db, created.album.id, 'u1')
    expect(stored).not.toBeNull()
    expect(stored!.name).toBe('Big videos')
    expect(stored!.filter.valid).toBe(true)
    expect(stored!.filter.valid && stored!.filter.tree).toEqual(VIDEOS_OVER_1K)
    expect(stored!.pinned).toBe(false)
    expect(stored!.sort).toBeNull()
    expect(stored!.createdAt).toBe(100)
    expect(listSmartAlbums(db, 'u1').map((album) => album.id)).toEqual([created.album.id])
  })

  test('a name is unique per user and compared case-insensitively', () => {
    expect(create('u1', 'Trips').kind).toBe('ok')
    expect(create('u1', 'trips').kind).toBe('name_taken')
    expect(create('u1', '  Trips  ').kind).toBe('name_taken')
    expect(create('u2', 'Trips').kind).toBe('ok')
  })

  test('another user cannot read, edit or delete the album', () => {
    const created = create('u1', 'Trips')
    if (created.kind !== 'ok') throw new Error('seed failed')
    const id = created.album.id

    expect(getSmartAlbum(db, id, 'u2')).toBeNull()
    expect(listSmartAlbums(db, 'u2')).toEqual([])
    expect(updateSmartAlbum(db, id, 'u2', { name: 'Stolen' }, 200).kind).toBe('missing')
    expect(deleteSmartAlbum(db, id, 'u2')).toBe(false)
    expect(getSmartAlbum(db, id, 'u1')?.name).toBe('Trips')
  })

  test('an update rewrites only the fields it was given', () => {
    const created = create('u1', 'Trips')
    if (created.kind !== 'ok') throw new Error('seed failed')
    const id = created.album.id
    expect(create('u1', 'Other', 150).kind).toBe('ok')
    const narrower: FilterTree = {
      version: 1,
      root: { type: 'cond', field: 'kind', operator: 'eq', value: 'image' },
    }

    const updated = updateSmartAlbum(db, id, 'u1', { filter: narrower, pinned: true }, 200)
    expect(updated.kind).toBe('ok')
    if (updated.kind !== 'ok') return
    expect(updated.album.name).toBe('Trips')
    expect(updated.album.pinned).toBe(true)
    expect(updated.album.filter.valid && updated.album.filter.tree).toEqual(narrower)
    expect(updated.album.createdAt).toBe(100)
    expect(updated.album.updatedAt).toBe(200)

    // Renaming onto another album's name is refused, whatever the case.
    expect(updateSmartAlbum(db, id, 'u1', { name: 'other' }, 300).kind).toBe('name_taken')
    expect(getSmartAlbum(db, id, 'u1')?.name).toBe('Trips')
    expect(updateSmartAlbum(db, id, 'u1', { name: 'Journeys', sort: 'views' }, 300)).toMatchObject({
      kind: 'ok',
      album: { name: 'Journeys', sort: 'views' },
    })
  })

  test('pinned albums come first, then the most recently edited', () => {
    const first = create('u1', 'First', 100)
    const second = create('u1', 'Second', 200)
    const third = create('u1', 'Third', 300)
    if (first.kind !== 'ok' || second.kind !== 'ok' || third.kind !== 'ok') {
      throw new Error('seed failed')
    }

    expect(listSmartAlbums(db, 'u1').map((album) => album.name)).toEqual(['Third', 'Second', 'First'])

    updateSmartAlbum(db, first.album.id, 'u1', { pinned: true }, 400)
    expect(listSmartAlbums(db, 'u1').map((album) => album.name)).toEqual(['First', 'Third', 'Second'])
  })

  test('a delete removes the album', () => {
    const created = create('u1', 'Trips')
    if (created.kind !== 'ok') throw new Error('seed failed')
    expect(deleteSmartAlbum(db, created.album.id, 'u1')).toBe(true)
    expect(getSmartAlbum(db, created.album.id, 'u1')).toBeNull()
    expect(deleteSmartAlbum(db, created.album.id, 'u1')).toBe(false)
  })

  test('a stored filter that no longer parses is reported, never treated as a match-all', () => {
    const created = create('u1', 'Trips')
    if (created.kind !== 'ok') throw new Error('seed failed')
    const id = created.album.id

    db.query<null, [string]>(`UPDATE smart_albums SET filter_json = '{' WHERE id = ?`).run(id)
    const broken = getSmartAlbum(db, id, 'u1')!
    expect(broken.filter.valid).toBe(false)
    expect(broken.filter.valid ? '' : broken.filter.error).toContain('JSON')

    const unknownField = JSON.stringify({
      version: 1,
      root: { type: 'cond', field: 'removedField', operator: 'eq', value: 1 },
    })
    db.query<null, [string, string]>(`UPDATE smart_albums SET filter_json = ? WHERE id = ?`).run(unknownField, id)
    expect(getSmartAlbum(db, id, 'u1')!.filter.valid).toBe(false)

    db.query<null, [string, string]>(`UPDATE smart_albums SET filter_json = ?, sort = 'gone' WHERE id = ?`).run(
      JSON.stringify(VIDEOS_OVER_1K),
      id,
    )
    const restored = getSmartAlbum(db, id, 'u1')!
    expect(restored.filter.valid).toBe(true)
    expect(restored.sort).toBeNull()
  })
})
