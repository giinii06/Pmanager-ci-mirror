import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  BOOKMARK_NOTE_MAX,
  BOOKMARK_TITLE_MAX,
  createBookmark,
  createLibrary,
  createUser,
  deleteBookmark,
  listBookmarks,
  openDatabase,
  updateBookmark,
  upsertFolder,
  insertAsset,
  type Db,
} from './index'

const OWNER = 'u1'
const GUEST = 'u2'

let db: Db

beforeEach(() => {
  db = openDatabase(':memory:')
  createUser(db, { id: OWNER, username: 'owner', passwordHash: 'h', createdAt: 1 })
  createUser(db, { id: GUEST, username: 'guest', passwordHash: 'h', createdAt: 1 })
  createLibrary(db, { id: 'lib1', name: 'Lib', rootPath: 'Lib', createdAt: 1 })
  const folderId = upsertFolder(db, {
    id: 'f1',
    libraryId: 'lib1',
    parentId: null,
    relativePath: 'Lib',
    name: 'Lib',
    depth: 0,
    scanId: 's1',
  })
  for (const [id, duration] of [
    ['v1', 60_000],
    ['v2', null],
  ] as const) {
    insertAsset(db, {
      id,
      libraryId: 'lib1',
      folderId,
      relativePath: `Lib/${id}.mp4`,
      filename: `${id}.mp4`,
      kind: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 1_000,
      mtimeMs: 1_000,
      width: 640,
      height: 480,
      durationMs: duration,
      takenAt: 1_000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      container: 'mp4',
      indexedAt: 1_000,
      scanId: 's1',
    })
  }
})

afterEach(() => {
  db.close()
})

function mark(assetId: string, positionMs: number, now = 100, title: string | null = null, note: string | null = null) {
  const result = createBookmark(db, { userId: OWNER, assetId, positionMs, title, note, now })
  if (result.kind !== 'ok') throw new Error(`could not bookmark ${assetId}: ${result.kind}`)
  return result.bookmark
}

describe('video bookmarks', () => {
  test('a mark records its timestamp, title and the file version it was made on', () => {
    const created = createBookmark(db, {
      userId: OWNER,
      assetId: 'v1',
      positionMs: 15_000,
      title: '  Opening  ',
      note: 'the good part',
      now: 100,
    })
    expect(created.kind).toBe('ok')
    if (created.kind !== 'ok') return
    expect(created.bookmark).toMatchObject({
      assetId: 'v1',
      positionMs: 15_000,
      title: 'Opening',
      note: 'the good part',
      fileVersion: 1,
      stale: false,
      createdAt: 100,
      updatedAt: 100,
    })
    expect(listBookmarks(db, OWNER, 'v1')).toHaveLength(1)
  })

  test('marks come back earliest first', () => {
    mark('v1', 30_000, 100)
    mark('v1', 5_000, 200)
    mark('v1', 20_000, 300)
    expect(listBookmarks(db, OWNER, 'v1').map((bookmark) => bookmark.positionMs)).toEqual([5_000, 20_000, 30_000])
    // A mark on another asset does not leak in.
    mark('v2', 1_000, 400)
    expect(listBookmarks(db, OWNER, 'v1').map((bookmark) => bookmark.positionMs)).toEqual([5_000, 20_000, 30_000])
  })

  test('a mark goes stale when the file version moves', () => {
    const created = mark('v1', 10_000)
    expect(listBookmarks(db, OWNER, 'v1')[0]?.stale).toBe(false)

    db.query<null, [string]>('UPDATE assets SET file_version = file_version + 1 WHERE id = ?').run('v1')
    const stale = listBookmarks(db, OWNER, 'v1')[0]!
    expect(stale.stale).toBe(true)
    expect(stale.fileVersion).toBe(created.fileVersion)
    expect(stale.positionMs).toBe(10_000)

    // Editing the title does not re-anchor the mark to the new file.
    const edited = updateBookmark(db, created.id, OWNER, { title: 'Still here' }, 500)
    expect(edited.kind).toBe('ok')
    if (edited.kind !== 'ok') return
    expect(edited.bookmark.stale).toBe(true)
    expect(edited.bookmark.fileVersion).toBe(created.fileVersion)
  })

  test('an update rewrites only the fields it was given', () => {
    const created = mark('v1', 10_000, 100, 'Start', 'note')
    const moved = updateBookmark(db, created.id, OWNER, { positionMs: 42_000 }, 200)
    expect(moved.kind).toBe('ok')
    if (moved.kind !== 'ok') return
    expect(moved.bookmark).toMatchObject({ positionMs: 42_000, title: 'Start', note: 'note', updatedAt: 200 })

    const cleared = updateBookmark(db, created.id, OWNER, { title: null, note: '  ' }, 300)
    expect(cleared.kind).toBe('ok')
    if (cleared.kind !== 'ok') return
    expect(cleared.bookmark).toMatchObject({ positionMs: 42_000, title: null, note: null })

    const untouched = updateBookmark(db, created.id, OWNER, {}, 400)
    expect(untouched.kind).toBe('ok')
    if (untouched.kind !== 'ok') return
    expect(untouched.bookmark.updatedAt).toBe(300)
  })

  test('a delete removes the mark', () => {
    const created = mark('v1', 10_000)
    expect(deleteBookmark(db, created.id, OWNER)).toBe(true)
    expect(listBookmarks(db, OWNER, 'v1')).toEqual([])
    expect(deleteBookmark(db, created.id, OWNER)).toBe(false)
  })

  test('a position outside the video is refused', () => {
    expect(createBookmark(db, { userId: OWNER, assetId: 'v1', positionMs: -1, title: null, note: null, now: 1 })).toEqual({
      kind: 'out_of_range',
      durationMs: 60_000,
    })
    expect(
      createBookmark(db, { userId: OWNER, assetId: 'v1', positionMs: 61_500, title: null, note: null, now: 1 }).kind,
    ).toBe('out_of_range')
    // A second of slack absorbs a player's rounding.
    expect(
      createBookmark(db, { userId: OWNER, assetId: 'v1', positionMs: 60_900, title: null, note: null, now: 1 }).kind,
    ).toBe('ok')
    // No duration means nothing to check against.
    expect(
      createBookmark(db, { userId: OWNER, assetId: 'v2', positionMs: 999_000, title: null, note: null, now: 1 }).kind,
    ).toBe('ok')

    const created = mark('v1', 10_000)
    expect(updateBookmark(db, created.id, OWNER, { positionMs: 120_000 }, 200).kind).toBe('out_of_range')
    expect(listBookmarks(db, OWNER, 'v1')[0]?.positionMs).toBe(10_000)
  })

  test('a mark cannot be made on an asset the library no longer holds', () => {
    expect(createBookmark(db, { userId: OWNER, assetId: 'nope', positionMs: 0, title: null, note: null, now: 1 }).kind).toBe(
      'asset_missing',
    )
    db.query<null, [number, string]>('UPDATE assets SET deleted_at = ? WHERE id = ?').run(500, 'v2')
    expect(createBookmark(db, { userId: OWNER, assetId: 'v2', positionMs: 0, title: null, note: null, now: 1 }).kind).toBe(
      'asset_missing',
    )
  })

  test('text beyond the limit is refused', () => {
    expect(() => mark('v1', 0, 1, 'x'.repeat(BOOKMARK_TITLE_MAX + 1))).toThrow(/120/)
    expect(() => mark('v1', 0, 1, null, 'x'.repeat(BOOKMARK_NOTE_MAX + 1))).toThrow(/2000/)
    expect(mark('v1', 0, 1, 'x'.repeat(BOOKMARK_TITLE_MAX)).title).toHaveLength(BOOKMARK_TITLE_MAX)
  })

  test('another user cannot read, edit or delete the mark', () => {
    const created = mark('v1', 10_000)

    expect(listBookmarks(db, GUEST, 'v1')).toEqual([])
    expect(updateBookmark(db, created.id, GUEST, { title: 'Stolen' }, 200).kind).toBe('missing')
    expect(deleteBookmark(db, created.id, GUEST)).toBe(false)
    expect(listBookmarks(db, OWNER, 'v1')[0]).toMatchObject({ title: null, positionMs: 10_000 })
  })
})
