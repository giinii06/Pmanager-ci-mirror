import { describe, expect, test } from 'bun:test'
import {
  createJournalEntry,
  createLibrary,
  createUser,
  deleteJournalEntry,
  getJournalEntry,
  insertAsset,
  listJournalEntries,
  openDatabase,
  searchJournalMentions,
  updateJournalEntry,
  upsertFolder,
} from './index'

describe('journal entries', () => {
  test('timestamps are creation-time snapshots; editing preserves the creation date', () => {
    const db = openDatabase(':memory:')
    createUser(db, { id: 'u1', username: 'user1', passwordHash: 'hash', createdAt: 1 })
    const first = createJournalEntry(db, 'u1', 1_700_000_000_000)
    const second = createJournalEntry(db, 'u1', 1_700_000_050_000)
    expect(first.title).toBe('')
    expect(first.body).toBe('')
    expect(first.createdAt).toBe(1_700_000_000_000)
    const edited = updateJournalEntry(db, 'u1', first.id, {
      title: '오늘의 일지',
      body: '오늘은 좋았다.',
    }, 1_700_000_060_000)
    expect(edited?.title).toBe('오늘의 일지')
    expect(edited?.body).toBe('오늘은 좋았다.')
    expect(edited?.createdAt).toBe(first.createdAt)
    expect(edited?.updatedAt).toBe(1_700_000_060_000)
    expect(listJournalEntries(db, 'u1').map((item) => item.id)).toEqual([second.id, first.id])
    expect(deleteJournalEntry(db, 'u1', first.id)).toBe(true)
    expect(getJournalEntry(db, 'u1', first.id)).toBeNull()
    expect(deleteJournalEntry(db, 'u1', first.id)).toBe(false)
    db.close()
  })

  test('pages are isolated per user, including edits and deletion', () => {
    const db = openDatabase(':memory:')
    createUser(db, { id: 'u1', username: 'user1', passwordHash: 'hash', createdAt: 1 })
    createUser(db, { id: 'u2', username: 'user2', passwordHash: 'hash', createdAt: 1 })
    const entry = createJournalEntry(db, 'u1', 1234)
    expect(getJournalEntry(db, 'u2', entry.id)).toBeNull()
    expect(listJournalEntries(db, 'u2')).toEqual([])
    expect(updateJournalEntry(db, 'u2', entry.id, { title: 'stolen' }, 1235)).toBeNull()
    expect(deleteJournalEntry(db, 'u2', entry.id)).toBe(false)
    expect(getJournalEntry(db, 'u1', entry.id)?.title).toBe('')
    db.close()
  })

  test('mention search returns only live videos and folders containing images', () => {
    const db = openDatabase(':memory:')
    createLibrary(db, { id: 'lib', name: 'Media', rootPath: 'Media', createdAt: 1 })
    upsertFolder(db, { id: 'photos', libraryId: 'lib', parentId: null, relativePath: 'trip', name: 'Trip photos', depth: 0, scanId: 'scan', createdAt: 1 })
    upsertFolder(db, { id: 'empty', libraryId: 'lib', parentId: null, relativePath: 'empty', name: 'Trip empty', depth: 0, scanId: 'scan', createdAt: 1 })
    for (const item of [
      { id: 'v1', folderId: 'photos', filename: 'Trip movie.mp4', kind: 'video' as const },
      { id: 'i1', folderId: 'photos', filename: 'Beach.jpg', kind: 'image' as const },
    ]) {
      insertAsset(db, {
        id: item.id,
        libraryId: 'lib',
        folderId: item.folderId,
        relativePath: item.filename,
        filename: item.filename,
        kind: item.kind,
        mimeType: item.kind === 'video' ? 'video/mp4' : 'image/jpeg',
        sizeBytes: 100,
        mtimeMs: 1,
        width: null,
        height: null,
        durationMs: null,
        takenAt: 1,
        videoCodec: null,
        audioCodec: null,
        container: null,
        indexedAt: 1,
        scanId: 'scan',
      })
    }
    const found = searchJournalMentions(db, 'Trip')
    expect(found.map((item) => [item.type, item.id])).toEqual([['video', 'v1'], ['album', 'photos']])
    expect(searchJournalMentions(db, 'empty')).toEqual([])
    db.close()
  })
})
