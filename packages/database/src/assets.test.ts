import { describe, expect, test } from 'bun:test'
import {
  createLibrary,
  createUser,
  getStats,
  insertAsset,
  listAssets,
  openDatabase,
  softDeleteMissing,
  touchAssets,
  upsertFolder,
  voteAsset,
} from './index'
import type { NewAsset } from './assets'

const USER = 'user1'
const LIBRARY = 'lib1'
const SCAN = 'scan1'

function seed() {
  const db = openDatabase(':memory:')
  createUser(db, { id: USER, username: 'demo', passwordHash: 'x', createdAt: 1 })
  createLibrary(db, { id: LIBRARY, name: 'Photos', rootPath: 'Photos', createdAt: 1 })
  const folderId = upsertFolder(db, {
    id: 'folder1',
    libraryId: LIBRARY,
    parentId: null,
    relativePath: 'Photos',
    name: 'Photos',
    depth: 0,
    scanId: SCAN,
  })

  const assets: NewAsset[] = Array.from({ length: 5 }, (_, index) => ({
    id: `asset${index}`,
    libraryId: LIBRARY,
    folderId,
    relativePath: `Photos/asset${index}.jpg`,
    filename: `asset${index}.jpg`,
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 1_000 + index,
    mtimeMs: 1_000 + index,
    width: 1_600,
    height: 1_067,
    durationMs: null,
    takenAt: 10_000 - index * 100,
    videoCodec: null,
    audioCodec: null,
    container: null,
    indexedAt: 20_000,
    scanId: SCAN,
  }))
  for (const asset of assets) insertAsset(db, asset)
  return db
}

describe('listAssets', () => {
  test('paginates by taken_at and id with a stable cursor', () => {
    const db = seed()
    const first = listAssets(db, {}, null, 2)
    expect(first.records.map((asset) => asset.id)).toEqual(['asset0', 'asset1'])
    expect(first.total).toBe(5)
    expect(first.hasMore).toBe(true)

    const last = first.records[1]!
    const second = listAssets(db, {}, { takenAt: last.takenAt, id: last.id }, 2)
    expect(second.records.map((asset) => asset.id)).toEqual(['asset2', 'asset3'])
    expect(second.hasMore).toBe(true)

    const end = second.records[1]!
    const third = listAssets(db, {}, { takenAt: end.takenAt, id: end.id }, 2)
    expect(third.records.map((asset) => asset.id)).toEqual(['asset4'])
    expect(third.hasMore).toBe(false)
    db.close()
  })

  test('accumulates repeated votes cleanly', () => {
    const db = seed()
    voteAsset(db, 'asset3')
    voteAsset(db, 'asset3')
    const sorted = listAssets(db, { sort: 'votes' }, null, 10)
    expect(sorted.records[0]?.id).toBe('asset3')
    expect(sorted.records[0]?.voteCount).toBe(2)
    db.close()
  })

  test('hides soft-deleted assets and reports stats', () => {
    const db = seed()
    expect(softDeleteMissing(db, LIBRARY, 'newer-scan', 40_000)).toBe(5)
    expect(listAssets(db, {}, null, 10).total).toBe(0)
    expect(getStats(db)).toMatchObject({ assets: 0, images: 0, videos: 0 })
    db.close()
  })

  test('touchAssets marks every id in the batch', () => {
    const db = seed()
    touchAssets(db, ['asset1', 'asset3'], 'scan2')
    const rows = db
      .query<{ id: string; lastSeenScan: string }, []>(
        'SELECT id, last_seen_scan AS lastSeenScan FROM assets ORDER BY id',
      )
      .all()
    expect(rows).toEqual([
      { id: 'asset0', lastSeenScan: SCAN },
      { id: 'asset1', lastSeenScan: 'scan2' },
      { id: 'asset2', lastSeenScan: SCAN },
      { id: 'asset3', lastSeenScan: 'scan2' },
      { id: 'asset4', lastSeenScan: SCAN },
    ])
    db.close()
  })
})
