import { describe, expect, test } from 'bun:test'
import {
  createLibrary,
  createUser,
  deleteReview,
  getReview,
  insertAsset,
  openDatabase,
  relatedAssets,
  upsertFolder,
  upsertReview,
} from './index'
import type { NewAsset } from './assets'

const USER = 'user1'
const LIBRARY = 'lib1'

function video(id: string, folderId: string, libraryId: string, takenAt: number): NewAsset {
  return {
    id,
    libraryId,
    folderId,
    relativePath: `Videos/${id}.mp4`,
    filename: `${id}.mp4`,
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 1_000,
    mtimeMs: takenAt,
    width: 1_920,
    height: 1_080,
    durationMs: 60_000,
    takenAt,
    videoCodec: 'h264',
    audioCodec: 'aac',
    container: 'mov,mp4',
    indexedAt: 1,
    scanId: 'scan1',
  }
}

function seed() {
  const db = openDatabase(':memory:')
  createUser(db, { id: USER, username: 'demo', passwordHash: 'x', createdAt: 1 })
  createLibrary(db, { id: LIBRARY, name: 'Videos', rootPath: 'Videos', createdAt: 1 })
  createLibrary(db, { id: 'lib2', name: 'Other', rootPath: 'Other', createdAt: 1 })
  const one = upsertFolder(db, {
    id: 'folder1',
    libraryId: LIBRARY,
    parentId: null,
    relativePath: 'Videos/One',
    name: 'One',
    depth: 0,
    scanId: 'scan1',
  })
  const two = upsertFolder(db, {
    id: 'folder2',
    libraryId: LIBRARY,
    parentId: null,
    relativePath: 'Videos/Two',
    name: 'Two',
    depth: 0,
    scanId: 'scan1',
  })

  insertAsset(db, video('v1', one, LIBRARY, 1_000))
  insertAsset(db, video('v2', one, LIBRARY, 2_000))
  insertAsset(db, video('v3', two, LIBRARY, 3_000))
  insertAsset(db, video('v4', one, 'lib2', 4_000))
  return db
}

describe('reviews', () => {
  test('a first review is stored and read back', () => {
    const db = seed()
    expect(getReview(db, 'v1', USER)).toBeNull()

    const review = upsertReview(
      db,
      { id: 'r1', assetId: 'v1', userId: USER, rating: 4, body: '다시 보고 싶다.' },
      10_000,
    )

    expect(review.rating).toBe(4)
    expect(review.body).toBe('다시 보고 싶다.')
    expect(getReview(db, 'v1', USER)?.id).toBe('r1')
    db.close()
  })

  test('a second write replaces the first instead of adding a row', () => {
    const db = seed()
    upsertReview(
      db,
      { id: 'r1', assetId: 'v1', userId: USER, rating: 2, body: '음...' },
      10_000,
    )
    const updated = upsertReview(
      db,
      { id: 'r2', assetId: 'v1', userId: USER, rating: 5, body: '두 번 봤다.' },
      20_000,
    )

    expect(updated.id).toBe('r1')
    expect(updated.rating).toBe(5)
    expect(updated.updatedAt).toBe(20_000)
    expect(
      db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM asset_reviews').get()?.n,
    ).toBe(1)
    db.close()
  })

  test('deleting removes the review and reports whether it existed', () => {
    const db = seed()
    upsertReview(
      db,
      { id: 'r1', assetId: 'v1', userId: USER, rating: 3, body: '보통' },
      10_000,
    )

    expect(deleteReview(db, 'v1', USER)).toBe(true)
    expect(deleteReview(db, 'v1', USER)).toBe(false)
    expect(getReview(db, 'v1', USER)).toBeNull()
    db.close()
  })

  test('a rating outside one to five is rejected by the table', () => {
    const db = seed()
    expect(() =>
      upsertReview(
        db,
        { id: 'r1', assetId: 'v1', userId: USER, rating: 6, body: '별 여섯 개' },
        10_000,
      ),
    ).toThrow()
    db.close()
  })

  test('a review belongs to one person and one asset', () => {
    const db = seed()
    createUser(db, { id: 'user2', username: 'other', passwordHash: 'x', createdAt: 1 })
    upsertReview(db, { id: 'r1', assetId: 'v1', userId: USER, rating: 5, body: '좋아요' }, 1_000)
    upsertReview(db, { id: 'r2', assetId: 'v2', userId: USER, rating: 4, body: '괜찮아요' }, 1_000)
    upsertReview(db, { id: 'r3', assetId: 'v1', userId: 'user2', rating: 3, body: '보통' }, 1_000)

    expect(getReview(db, 'v1', USER)?.body).toBe('좋아요')
    expect(getReview(db, 'v2', USER)?.body).toBe('괜찮아요')
    expect(getReview(db, 'v1', 'user2')?.body).toBe('보통')
    db.close()
  })
})

describe('related assets', () => {
  test('same folder first, then the rest of the library, videos only', () => {
    const db = seed()

    expect(relatedAssets(db, USER, 'v1', 10).map((asset) => asset.id)).toEqual(['v2', 'v3'])
    db.close()
  })

  test('another library never leaks into the list', () => {
    const db = seed()
    expect(relatedAssets(db, USER, 'v1', 10).some((asset) => asset.id === 'v4')).toBe(false)
    db.close()
  })

  test('the limit is respected', () => {
    const db = seed()
    expect(relatedAssets(db, USER, 'v1', 1).map((asset) => asset.id)).toEqual(['v2'])
    db.close()
  })
})
