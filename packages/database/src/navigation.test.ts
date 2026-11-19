import { describe, expect, test } from 'bun:test'
import type { VideoSort } from '@mediavault/shared'
import {
  createLibrary,
  createUser,
  getAssetNeighbor,
  insertAsset,
  listAssets,
  openDatabase,
  pickRandomAsset,
  upsertFolder,
  type AssetFilter,
  type Db,
} from './index'

const SORTS: VideoSort[] = ['latest', 'name', 'views', 'watch_time', 'votes', 'rate']

function insertVideo(db: Db, id: string, index: number, folderId = 'folder0001'): void {
  insertAsset(db, {
    id,
    libraryId: 'lib1',
    folderId,
    relativePath: `${folderId}/${id}.mp4`,
    filename: index % 2 === 0 ? `Clip ${index}.mp4` : `clip ${index}.mp4`,
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 1000 + index,
    mtimeMs: 1000 + index,
    width: 160,
    height: 120,
    durationMs: 120_000,
    takenAt: 1000 + (index % 5) * 10,
    videoCodec: 'h264',
    audioCodec: null,
    container: 'mp4',
    indexedAt: 1,
    scanId: 's1',
  })
  const rated = index % 3 !== 0
  const viewCount = rated ? 2 + (index % 4) : 0
  const watchTimeMs = rated ? 1000 * (1 + (index % 3)) : 0
  db.run('UPDATE assets SET view_count = ?, watch_time_ms = ?, vote_count = ? WHERE id = ?', [
    viewCount,
    watchTimeMs,
    index % 4,
    id,
  ])
}

function seeded(): Db {
  const db = openDatabase(':memory:')
  createUser(db, { id: 'u1', username: 'owner', passwordHash: 'x', createdAt: 1 })
  createLibrary(db, { id: 'lib1', name: 'Media', rootPath: '/media', createdAt: 1 })
  upsertFolder(db, {
    id: 'folder0001',
    libraryId: 'lib1',
    parentId: null,
    relativePath: '',
    name: 'Media',
    depth: 0,
    scanId: 's1',
    createdAt: 1,
  })
  upsertFolder(db, {
    id: 'folder0002',
    libraryId: 'lib1',
    parentId: null,
    relativePath: 'small',
    name: 'small',
    depth: 0,
    scanId: 's1',
    createdAt: 1,
  })
  for (let index = 0; index < 24; index += 1) {
    insertVideo(db, `v${String(index).padStart(6, '0')}`, index)
  }
  insertVideo(db, 's000001', 1, 'folder0002')
  insertVideo(db, 's000002', 2, 'folder0002')
  insertAsset(db, {
    id: 'i000001',
    libraryId: 'lib1',
    folderId: 'folder0001',
    relativePath: 'photo.jpg',
    filename: 'photo.jpg',
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 500,
    mtimeMs: 500,
    width: 100,
    height: 100,
    durationMs: null,
    takenAt: 900,
    videoCodec: null,
    audioCodec: null,
    container: null,
    indexedAt: 1,
    scanId: 's1',
  })
  return db
}

function idsFor(db: Db, filter: AssetFilter): string[] {
  return listAssets(db, filter, null, 100).records.map((record) => record.id)
}

describe('asset neighbor', () => {
  for (const sort of SORTS) {
    test(`matches the list order for ${sort}`, () => {
      const db = seeded()
      const filter: AssetFilter = { kind: 'video', sort }
      if (sort === 'rate') filter.seed = 11
      const ids = idsFor(db, filter)
      expect(ids).toHaveLength(26)

      const beforeFirst = getAssetNeighbor(db, ids[0]!, filter, 'prev')
      expect(beforeFirst).toEqual({ kind: 'ok', record: null })
      const afterLast = getAssetNeighbor(db, ids[ids.length - 1]!, filter, 'next')
      expect(afterLast).toEqual({ kind: 'ok', record: null })

      for (let index = 1; index < ids.length - 1; index += 1) {
        const next = getAssetNeighbor(db, ids[index]!, filter, 'next')
        expect(next.kind).toBe('ok')
        if (next.kind === 'ok') expect(next.record?.id).toBe(ids[index + 1])
        const prev = getAssetNeighbor(db, ids[index]!, filter, 'prev')
        expect(prev.kind).toBe('ok')
        if (prev.kind === 'ok') expect(prev.record?.id).toBe(ids[index - 1])
      }
    })
  }

  test('follows the same seed the list used', () => {
    const db = seeded()
    const filter: AssetFilter = { kind: 'video', sort: 'rate', seed: 42 }
    const ids = idsFor(db, filter)
    const next = getAssetNeighbor(db, ids[3]!, filter, 'next')
    expect(next.kind).toBe('ok')
    if (next.kind === 'ok') expect(next.record?.id).toBe(ids[4])

    const other = idsFor(db, { ...filter, seed: 43 })
    const otherNext = getAssetNeighbor(db, other[3]!, { ...filter, seed: 43 }, 'next')
    expect(otherNext.kind).toBe('ok')
    if (otherNext.kind === 'ok') expect(otherNext.record?.id).toBe(other[4])
  })

  test('separates a missing asset from one outside the filter', () => {
    const db = seeded()
    const filter: AssetFilter = { kind: 'video' }
    expect(getAssetNeighbor(db, 'v000000', { kind: 'image' }, 'next').kind).toBe('outside_filter')
    expect(getAssetNeighbor(db, 'nope0000', filter, 'next').kind).toBe('missing')

    db.run('UPDATE assets SET deleted_at = 1 WHERE id = ?', ['v000003'])
    expect(getAssetNeighbor(db, 'v000003', filter, 'next').kind).toBe('missing')
  })
})

describe('random asset', () => {
  test('stays inside the filter and skips the current and recent assets', () => {
    const db = seeded()
    const all = idsFor(db, { kind: 'video' })
    const current = all[0]!
    const recent = all.slice(1, 6)
    for (let seed = 0; seed < 60; seed += 1) {
      const picked = pickRandomAsset(db, { kind: 'video' }, {
        currentAssetId: current,
        recentIds: recent,
        seed,
      })
      expect(picked).not.toBeNull()
      expect(picked!.id).not.toBe(current)
      expect(recent).not.toContain(picked!.id)
    }
  })

  test('relaxes the recent list before giving up', () => {
    const db = seeded()
    const filter: AssetFilter = { folderId: 'folder0002' }
    const picked = pickRandomAsset(db, filter, {
      currentAssetId: 's000001',
      recentIds: ['s000002'],
      seed: 5,
    })
    expect(picked?.id).toBe('s000002')
  })

  test('returns null when only the current asset matches', () => {
    const db = seeded()
    expect(pickRandomAsset(db, { folderId: 'folder0002' }, {
      currentAssetId: 's000001',
      recentIds: ['s000001'],
      seed: 5,
    })).not.toBeNull()

    db.run('UPDATE assets SET deleted_at = 1 WHERE id = ?', ['s000002'])
    expect(pickRandomAsset(db, { folderId: 'folder0002' }, {
      currentAssetId: 's000001',
      seed: 5,
    })).toBeNull()
    expect(pickRandomAsset(db, { folderId: 'missing0' }, { seed: 5 })).toBeNull()
  })

  test('covers the eligible set without favouring an id', () => {
    const db = seeded()
    const counts = new Map<string, number>()
    for (let draw = 0; draw < 1200; draw += 1) {
      const picked = pickRandomAsset(db, { kind: 'video' }, {})
      if (picked) counts.set(picked.id, (counts.get(picked.id) ?? 0) + 1)
    }
    expect(counts.size).toBe(26)
    const values = [...counts.values()]
    expect(Math.min(...values)).toBeGreaterThan(5)
    expect(Math.max(...values)).toBeLessThan(130)
  })
})
