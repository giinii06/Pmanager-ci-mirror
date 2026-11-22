import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
  test('reopening an existing v26 database runs the additive journal migration', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mv-journal-upgrade-'))
    try {
      const filename = path.join(dir, 'existing.db')
      const old = openDatabase(filename)
      createUser(old, { id: 'u1', username: 'user1', passwordHash: 'hash', createdAt: 1 })
      // Simulate an existing v26 file: keep its data, but drop the v27 addition.
      old.exec('DROP TABLE journal_entries')
      old.exec('PRAGMA user_version = 26')
      old.close()

      const upgraded = openDatabase(filename)
      expect(upgraded.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(29)
      const created = createJournalEntry(upgraded, 'u1', 1234)
      expect(getJournalEntry(upgraded, 'u1', created.id)?.createdAt).toBe(1234)
      expect(upgraded.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM users').get()?.n).toBe(1)
      upgraded.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

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
    }, first.updatedAt, 1_700_000_060_000)
    expect(edited.kind).toBe('ok')
    if (edited.kind !== 'ok') throw new Error('update rejected')
    expect(edited.entry.title).toBe('오늘의 일지')
    expect(edited.entry.body).toBe('오늘은 좋았다.')
    expect(edited.entry.createdAt).toBe(first.createdAt)
    expect(edited.entry.updatedAt).toBe(1_700_000_060_000)
    expect(listJournalEntries(db, 'u1').items.map((item) => item.id)).toEqual([second.id, first.id])
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
    expect(listJournalEntries(db, 'u2').items).toEqual([])
    expect(updateJournalEntry(db, 'u2', entry.id, { title: 'stolen' }, entry.updatedAt, 1235)).toEqual({ kind: 'missing' })
    expect(deleteJournalEntry(db, 'u2', entry.id)).toBe(false)
    expect(getJournalEntry(db, 'u1', entry.id)?.title).toBe('')
    db.close()
  })

  test('concurrent edits cannot silently overwrite another tab', () => {
    const db = openDatabase(':memory:')
    createUser(db, { id: 'u1', username: 'user1', passwordHash: 'hash', createdAt: 1 })
    const entry = createJournalEntry(db, 'u1', 100)
    const first = updateJournalEntry(db, 'u1', entry.id, { title: 'first tab' }, 100, 101)
    expect(first.kind).toBe('ok')
    const stale = updateJournalEntry(db, 'u1', entry.id, { title: 'stale second tab' }, 100, 102)
    expect(stale.kind).toBe('conflict')
    if (stale.kind !== 'conflict') throw new Error('expected version conflict')
    expect(stale.current.title).toBe('first tab')
    expect(getJournalEntry(db, 'u1', entry.id)?.title).toBe('first tab')
    const fresh = updateJournalEntry(db, 'u1', entry.id, { body: 'new body' }, stale.current.updatedAt, 103)
    expect(fresh.kind).toBe('ok')
    db.close()
  })

  test('keyset pagination finds every page after 500 entries, even tied timestamps', () => {
    const db = openDatabase(':memory:')
    createUser(db, { id: 'u1', username: 'user1', passwordHash: 'hash', createdAt: 1 })
    const ids = new Set<string>()
    for (let index = 0; index < 510; index++) {
      ids.add(createJournalEntry(db, 'u1', 1000).id)
    }
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 20; page++) {
      const result = listJournalEntries(db, 'u1', cursor)
      seen.push(...result.items.map((item) => item.id))
      cursor = result.nextCursor
      if (!cursor) break
      if (page === 0) {
        // A new entry added after pagination begins doesn't shift old pages.
        createJournalEntry(db, 'u1', 2000)
      }
    }
    expect(seen.length).toBe(510)
    expect(new Set(seen).size).toBe(510)
    expect(seen.every((id) => ids.has(id))).toBe(true)
    expect(cursor).toBeNull()
    expect(() => listJournalEntries(db, 'u1', 'oops')).toThrow()
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
