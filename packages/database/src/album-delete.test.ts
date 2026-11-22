import { describe, expect, test } from 'bun:test'
import {
  createLibrary, createUser, getAlbumDeleteStatus, insertAsset,
  listAllFolders, openDatabase, queueAlbumPhotoDeletion, upsertFolder,
} from './index'

function seededAlbum() {
  const db = openDatabase(':memory:')
  createUser(db, { id: 'user', username: 'admin', passwordHash: 'x', createdAt: 1 })
  createLibrary(db, { id: 'library', name: 'Media', rootPath: 'Media', createdAt: 1 })
  upsertFolder(db, {
    id: 'root', libraryId: 'library', parentId: null, relativePath: '', name: 'Media',
    depth: 0, scanId: 'scan',
  })
  upsertFolder(db, {
    id: 'album', libraryId: 'library', parentId: 'root', relativePath: 'Album',
    name: 'Album', depth: 1, scanId: 'scan',
  })
  upsertFolder(db, {
    id: 'child', libraryId: 'library', parentId: 'album', relativePath: 'Album/Child',
    name: 'Child', depth: 2, scanId: 'scan',
  })
  for (const input of [
    { id: 'photo1', folderId: 'album', kind: 'image', relativePath: 'Album/a.jpg' },
    { id: 'photo2', folderId: 'album', kind: 'image', relativePath: 'Album/b.jpg' },
    { id: 'video1', folderId: 'album', kind: 'video', relativePath: 'Album/v.mp4' },
    { id: 'child-photo', folderId: 'child', kind: 'image', relativePath: 'Album/Child/c.jpg' },
  ] as const) {
    insertAsset(db, {
      id: input.id, libraryId: 'library', folderId: input.folderId,
      relativePath: input.relativePath, filename: input.relativePath.split('/').pop()!,
      kind: input.kind, mimeType: input.kind === 'image' ? 'image/jpeg' : 'video/mp4',
      sizeBytes: 100, mtimeMs: 1, width: 64, height: 64, durationMs: null,
      takenAt: 100, videoCodec: null, audioCodec: null,
      container: null, indexedAt: 1, scanId: 'scan',
    })
  }
  return db
}

describe('photo album deletion queue', () => {
  test('queues direct images only, idempotently, and hides the album immediately', () => {
    const db = seededAlbum()
    const input = { folderId: 'album', userId: 'user', requestKey: 'request-1', now: 100 }
    const first = queueAlbumPhotoDeletion(db, input)
    expect(first.status).toBe('ok')
    if (first.status !== 'ok') return
    expect(first.batch).toMatchObject({ total: 2, completed: 0, failed: 0, pending: 2, state: 'pending' })
    expect(listAllFolders(db).map((folder) => folder.id)).not.toContain('album')
    expect(listAllFolders(db).map((folder) => folder.id)).toContain('child')
    const queued = db.query<{ assetId: string }, []>(
      "SELECT asset_id AS assetId FROM file_mutations WHERE kind = 'delete' ORDER BY asset_id",
    ).all().map((row) => row.assetId)
    expect(queued).toEqual(['photo1', 'photo2'])
    const second = queueAlbumPhotoDeletion(db, input)
    expect(second).toEqual({ status: 'ok', batch: first.batch, created: false })
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM file_mutations').get()?.n).toBe(2)
    expect(queueAlbumPhotoDeletion(db, { ...input, requestKey: 'another' }).status).toBe('conflict')
    db.close()
  })

  test('blocked deletes restore visibility and expose failure status', () => {
    const db = seededAlbum()
    const queued = queueAlbumPhotoDeletion(db, {
      folderId: 'album', userId: 'user', requestKey: 'error', now: 100,
    })
    expect(queued.status).toBe('ok')
    if (queued.status !== 'ok') return
    db.query("UPDATE file_mutations SET state = 'blocked' WHERE asset_id = 'photo1'").run()
    expect(getAlbumDeleteStatus(db, queued.batch.id, 'user')).toMatchObject({
      state: 'failed', failed: 1, total: 2,
    })
    expect(listAllFolders(db).map((folder) => folder.id)).toContain('album')
    expect(getAlbumDeleteStatus(db, queued.batch.id, 'another-user')).toBeNull()
    db.close()
  })

  test('a fully finished batch never hides newly indexed photos', () => {
    const db = seededAlbum()
    const result = queueAlbumPhotoDeletion(db, {
      folderId: 'album', userId: 'user', requestKey: 'finished', now: 100,
    })
    expect(result.status).toBe('ok')
    db.query("UPDATE file_mutations SET state = 'completed'").run()
    expect(listAllFolders(db).map((folder) => folder.id)).toContain('album')
    db.close()
  })

  test('empty album cannot start a deletion', () => {
    const db = seededAlbum()
    expect(queueAlbumPhotoDeletion(db, {
      folderId: 'root', userId: 'user', requestKey: 'empty', now: 100,
    })).toEqual({ status: 'empty' })
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM album_delete_batches').get()?.n).toBe(0)
    db.close()
  })
})
