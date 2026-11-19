import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  addPlaylistItem,
  createLibrary,
  createPlaylist,
  createUser,
  deletePlaylist,
  ensureWatchLater,
  getPlaylist,
  insertAsset,
  listPlaylistAssets,
  listPlaylistItems,
  listPlaylists,
  movePlaylistItem,
  openDatabase,
  removePlaylistItem,
  updatePlaylist,
  upsertFolder,
  type Db,
} from './index'

const OWNER = 'u1'
const GUEST = 'u2'

let db: Db
let folderId: string

beforeEach(() => {
  db = openDatabase(':memory:')
  createUser(db, { id: OWNER, username: 'owner', passwordHash: 'h', createdAt: 1 })
  createUser(db, { id: GUEST, username: 'guest', passwordHash: 'h', createdAt: 1 })
  createLibrary(db, { id: 'lib1', name: 'Lib', rootPath: 'Lib', createdAt: 1 })
  folderId = upsertFolder(db, {
    id: 'f1',
    libraryId: 'lib1',
    parentId: null,
    relativePath: 'Lib',
    name: 'Lib',
    depth: 0,
    scanId: 's1',
  })
  for (const id of ['a1', 'a2', 'a3']) {
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
      durationMs: 60_000,
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

function custom(userId: string, name: string, now = 100) {
  const result = createPlaylist(db, { userId, name, description: null, kind: 'custom', now })
  if (result.kind !== 'ok') throw new Error(`could not create ${name}: ${result.kind}`)
  return result.playlist
}

function add(playlistId: string, assetId: string, now = 200) {
  const result = addPlaylistItem(db, { playlistId, userId: OWNER, assetId, now })
  if (result.kind !== 'ok') throw new Error(`could not add ${assetId}: ${result.kind}`)
  return result.item
}

describe('playlists', () => {
  test('a list is created, read back, renamed and deleted', () => {
    const created = createPlaylist(db, {
      userId: OWNER,
      name: '  Road trip  ',
      description: 'summer',
      kind: 'custom',
      now: 100,
    })
    expect(created.kind).toBe('ok')
    if (created.kind !== 'ok') return
    expect(created.playlist.name).toBe('Road trip')
    expect(created.playlist.kind).toBe('custom')
    expect(created.playlist.itemCount).toBe(0)
    expect(created.playlist.availableCount).toBe(0)

    const read = getPlaylist(db, created.playlist.id, OWNER)
    expect(read).toMatchObject({ name: 'Road trip', description: 'summer', createdAt: 100, updatedAt: 100 })
    expect(listPlaylists(db, OWNER).map((list) => list.id)).toEqual([created.playlist.id])

    const renamed = updatePlaylist(db, created.playlist.id, OWNER, { name: 'Road trip 2026' }, 300)
    expect(renamed.kind).toBe('ok')
    if (renamed.kind !== 'ok') return
    expect(renamed.playlist.name).toBe('Road trip 2026')
    expect(renamed.playlist.description).toBe('summer')
    expect(renamed.playlist.updatedAt).toBe(300)

    expect(deletePlaylist(db, created.playlist.id, OWNER)).toBe(true)
    expect(getPlaylist(db, created.playlist.id, OWNER)).toBeNull()
    expect(deletePlaylist(db, created.playlist.id, OWNER)).toBe(false)
  })

  test('a name is unique per user and compared case-insensitively', () => {
    custom(OWNER, 'Trips')
    expect(createPlaylist(db, { userId: OWNER, name: 'trips', description: null, kind: 'custom', now: 1 }).kind).toBe(
      'name_taken',
    )
    expect(createPlaylist(db, { userId: OWNER, name: '  TRIPS ', description: null, kind: 'custom', now: 1 }).kind).toBe(
      'name_taken',
    )
    expect(createPlaylist(db, { userId: GUEST, name: 'Trips', description: null, kind: 'custom', now: 1 }).kind).toBe(
      'ok',
    )

    const second = custom(OWNER, 'Archive')
    expect(updatePlaylist(db, second.id, OWNER, { name: 'trips' }, 2).kind).toBe('name_taken')
    expect(getPlaylist(db, second.id, OWNER)?.name).toBe('Archive')
  })

  test('watch later is created on demand and stays a single list', () => {
    const first = ensureWatchLater(db, OWNER, 100)
    expect(first.kind).toBe('watch_later')
    expect(first.name).toBe('나중에 보기')

    const second = ensureWatchLater(db, OWNER, 200)
    expect(second.id).toBe(first.id)
    expect(listPlaylists(db, OWNER).filter((list) => list.kind === 'watch_later')).toHaveLength(1)

    // The partial unique index refuses a second watch-later row, and the write
    // returns the one that already exists instead of failing.
    const direct = createPlaylist(db, {
      userId: OWNER,
      name: 'Later',
      description: null,
      kind: 'watch_later',
      now: 300,
    })
    expect(direct.kind).toBe('ok')
    if (direct.kind !== 'ok') return
    expect(direct.playlist.id).toBe(first.id)

    // Another user gets their own.
    expect(ensureWatchLater(db, GUEST, 400).id).not.toBe(first.id)
  })

  test('watch later still appears when a custom list already holds its name', () => {
    const taken = custom(OWNER, '나중에 보기')
    const later = ensureWatchLater(db, OWNER, 100)
    expect(later.kind).toBe('watch_later')
    expect(later.id).not.toBe(taken.id)
    expect(later.name).not.toBe(taken.name)
    expect(getPlaylist(db, taken.id, OWNER)?.kind).toBe('custom')
    expect(ensureWatchLater(db, OWNER, 200).id).toBe(later.id)
  })

  test('watch later is listed first, then the most recently changed', () => {
    const older = custom(OWNER, 'Older', 100)
    const newer = custom(OWNER, 'Newer', 200)
    const later = ensureWatchLater(db, OWNER, 300)
    expect(listPlaylists(db, OWNER).map((list) => list.id)).toEqual([later.id, newer.id, older.id])

    updatePlaylist(db, older.id, OWNER, { description: 'touched' }, 400)
    expect(listPlaylists(db, OWNER).map((list) => list.id)).toEqual([later.id, older.id, newer.id])
  })

  test('items append in order and the same asset may appear twice', () => {
    const list = custom(OWNER, 'Queue')
    const first = add(list.id, 'a1', 200)
    const second = add(list.id, 'a2', 210)
    const again = add(list.id, 'a1', 220)

    expect([first.position, second.position, again.position]).toEqual([0, 1, 2])
    expect(listPlaylistItems(db, list.id, OWNER).map((item) => [item.assetId, item.position, item.available])).toEqual([
      ['a1', 0, true],
      ['a2', 1, true],
      ['a1', 2, true],
    ])
    const counted = getPlaylist(db, list.id, OWNER)!
    expect(counted.itemCount).toBe(3)
    expect(counted.availableCount).toBe(3)
    expect(counted.updatedAt).toBe(220)
  })

  test('a move lifts one item and leaves the others in order', () => {
    const list = custom(OWNER, 'Queue')
    const items = ['a1', 'a2', 'a3', 'a1'].map((assetId, index) => add(list.id, assetId, 200 + index))
    const order = () => listPlaylistItems(db, list.id, OWNER).map((item) => item.id)

    // Move the first item to the end.
    expect(movePlaylistItem(db, list.id, items[0]!.id, 3, OWNER)).toBe(true)
    expect(order()).toEqual([items[1]!.id, items[2]!.id, items[3]!.id, items[0]!.id])
    expect(listPlaylistItems(db, list.id, OWNER).map((item) => item.position)).toEqual([0, 1, 2, 3])

    // Move the last item to the front.
    expect(movePlaylistItem(db, list.id, items[0]!.id, 0, OWNER)).toBe(true)
    expect(order()).toEqual([items[0]!.id, items[1]!.id, items[2]!.id, items[3]!.id])

    // An index past the end clamps to the end, a negative one to the front.
    expect(movePlaylistItem(db, list.id, items[1]!.id, 99, OWNER)).toBe(true)
    expect(order()).toEqual([items[0]!.id, items[2]!.id, items[3]!.id, items[1]!.id])
    expect(movePlaylistItem(db, list.id, items[1]!.id, -5, OWNER)).toBe(true)
    expect(order()).toEqual([items[1]!.id, items[0]!.id, items[2]!.id, items[3]!.id])

    expect(movePlaylistItem(db, list.id, 'nope', 0, OWNER)).toBe(false)
    expect(order()).toEqual([items[1]!.id, items[0]!.id, items[2]!.id, items[3]!.id])
  })

  test('removing an item closes the gap it left', () => {
    const list = custom(OWNER, 'Queue')
    const items = ['a1', 'a2', 'a3'].map((assetId, index) => add(list.id, assetId, 200 + index))

    expect(removePlaylistItem(db, list.id, items[1]!.id, OWNER)).toBe(true)
    expect(listPlaylistItems(db, list.id, OWNER).map((item) => item.assetId)).toEqual(['a1', 'a3'])
    expect(removePlaylistItem(db, list.id, items[1]!.id, OWNER)).toBe(false)
    expect(getPlaylist(db, list.id, OWNER)?.itemCount).toBe(2)
  })

  test('a soft-deleted asset keeps its slot and drops out of the playable list', () => {
    const list = custom(OWNER, 'Queue')
    add(list.id, 'a1', 200)
    add(list.id, 'a2', 210)
    db.query<null, [number, string]>('UPDATE assets SET deleted_at = ? WHERE id = ?').run(500, 'a1')

    expect(listPlaylistItems(db, list.id, OWNER)).toMatchObject([
      { assetId: 'a1', position: 0, available: false },
      { assetId: 'a2', position: 1, available: true },
    ])
    expect(listPlaylistAssets(db, list.id, OWNER).map((asset) => asset.id)).toEqual(['a2'])
    const counted = getPlaylist(db, list.id, OWNER)!
    expect([counted.itemCount, counted.availableCount]).toEqual([2, 1])
  })

  test('deleting a playlist removes its items and leaves the assets alone', () => {
    const list = custom(OWNER, 'Queue')
    add(list.id, 'a1')
    add(list.id, 'a2')
    expect(deletePlaylist(db, list.id, OWNER)).toBe(true)

    const remaining =
      db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(list.id)?.n
    expect(remaining).toBe(0)
    const assets = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM assets WHERE deleted_at IS NULL').get()?.n
    expect(assets).toBe(3)
  })

  test('another user cannot read or change the list', () => {
    const list = custom(OWNER, 'Queue')
    const item = add(list.id, 'a1')

    expect(getPlaylist(db, list.id, GUEST)).toBeNull()
    expect(listPlaylists(db, GUEST)).toEqual([])
    expect(listPlaylistItems(db, list.id, GUEST)).toEqual([])
    expect(listPlaylistAssets(db, list.id, GUEST)).toEqual([])
    expect(updatePlaylist(db, list.id, GUEST, { name: 'Stolen' }, 300).kind).toBe('missing')
    expect(deletePlaylist(db, list.id, GUEST)).toBe(false)
    expect(addPlaylistItem(db, { playlistId: list.id, userId: GUEST, assetId: 'a2', now: 300 }).kind).toBe('missing')
    expect(removePlaylistItem(db, list.id, item.id, GUEST)).toBe(false)
    expect(movePlaylistItem(db, list.id, item.id, 0, GUEST)).toBe(false)

    expect(getPlaylist(db, list.id, OWNER)?.name).toBe('Queue')
    expect(listPlaylistItems(db, list.id, OWNER)).toHaveLength(1)
  })

  test('an item cannot be added for an asset the library no longer holds', () => {
    const list = custom(OWNER, 'Queue')
    expect(addPlaylistItem(db, { playlistId: list.id, userId: OWNER, assetId: 'nope', now: 200 }).kind).toBe(
      'asset_missing',
    )
    db.query<null, [number, string]>('UPDATE assets SET deleted_at = ? WHERE id = ?').run(500, 'a2')
    expect(addPlaylistItem(db, { playlistId: list.id, userId: OWNER, assetId: 'a2', now: 200 }).kind).toBe(
      'asset_missing',
    )
    expect(listPlaylistItems(db, list.id, OWNER)).toEqual([])
  })

  test('the playable items carry their tags and rates', () => {
    const list = custom(OWNER, 'Queue')
    add(list.id, 'a1')
    const assets = listPlaylistAssets(db, list.id, OWNER)
    expect(assets).toHaveLength(1)
    expect(assets[0]).toMatchObject({ id: 'a1', rate: null, tags: [] })
  })
})
