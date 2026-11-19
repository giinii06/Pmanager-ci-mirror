import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  applyPlayEvent,
  createLibrary,
  createPlaySession,
  createUser,
  getPlaySession,
  getProgress,
  insertAsset,
  openDatabase,
  prunePlaySessions,
  putProgress,
  upsertFolder,
  voteAsset,
  voteFolder,
  type Db,
} from './index'
import { MIGRATIONS, SCHEMA_VERSION } from './schema'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function seed(db: Db): void {
  createUser(db, { id: 'u1', username: 'owner', passwordHash: 'x', createdAt: 1 })
  createUser(db, { id: 'u2', username: 'other', passwordHash: 'x', createdAt: 1 })
  createLibrary(db, { id: 'lib1', name: 'Videos', rootPath: '/media', createdAt: 1 })
  upsertFolder(db, {
    id: 'folder0001',
    libraryId: 'lib1',
    parentId: null,
    relativePath: '',
    name: 'Videos',
    depth: 0,
    scanId: 's1',
    createdAt: 1,
  })
  insertAsset(db, {
    id: 'asset0001',
    libraryId: 'lib1',
    folderId: 'folder0001',
    relativePath: 'clip.mp4',
    filename: 'clip.mp4',
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 1000,
    mtimeMs: 1000,
    width: 160,
    height: 120,
    durationMs: 120_000,
    takenAt: 1000,
    videoCodec: 'h264',
    audioCodec: null,
    container: 'mp4',
    indexedAt: 1,
    scanId: 's1',
  })
}

function openSeeded(): Db {
  const db = openDatabase(':memory:')
  seed(db)
  return db
}

function startSession(
  db: Db,
  overrides: Partial<Parameters<typeof createPlaySession>[1]> = {},
): ReturnType<typeof createPlaySession> {
  return createPlaySession(db, {
    id: 'session00001',
    userId: 'u1',
    assetId: 'asset0001',
    fileVersion: 1,
    clientSessionKey: 'clientkey01',
    now: 10_000,
    ...overrides,
  })
}

describe('schema v20 playback sessions', () => {
  test('migrates a v19 database and keeps counters and progress', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mv-v20-'))
    dirs.push(dir)
    const file = path.join(dir, 'legacy.db')

    const legacy = new Database(file)
    legacy.exec('PRAGMA foreign_keys = ON')
    for (let index = 0; index < 19; index += 1) {
      MIGRATIONS[index]!((sql) => legacy.exec(sql))
    }
    legacy.exec('PRAGMA user_version = 19')
    legacy
      .query('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run('u1', 'owner', 'hash', 1)
    legacy
      .query(
        `INSERT INTO libraries (id, name, root_path, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run('lib1', 'Videos', '/media', 1)
    legacy
      .query(
        `INSERT INTO assets (
           id, library_id, relative_path, filename, kind, mime_type, size_bytes, mtime_ms,
           width, height, duration_ms, taken_at, video_codec, container, indexed_at, file_version,
           view_count, watch_time_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'asset0001',
        'lib1',
        'clip.mp4',
        'clip.mp4',
        'video',
        'video/mp4',
        1000,
        1000,
        160,
        120,
        120_000,
        1000,
        'h264',
        'mp4',
        1,
        3,
        7,
        42_000,
      )
    legacy
      .query(
        `INSERT INTO playback_progress (user_id, asset_id, position_ms, duration_ms, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('u1', 'asset0001', 30_000, 120_000, 5_000)
    legacy.close()

    const db = openDatabase(file)
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(
      SCHEMA_VERSION,
    )
    expect(SCHEMA_VERSION).toBe(20)
    const progress = getProgress(db, 'u1', 'asset0001')
    expect(progress).toMatchObject({
      positionMs: 30_000,
      durationMs: 120_000,
      fileVersion: 3,
      progressVersion: 0,
      lastSessionId: null,
      lastSeq: 0,
    })
    const asset = db
      .query<{ viewCount: number; watchTimeMs: number }, []>(
        'SELECT view_count AS viewCount, watch_time_ms AS watchTimeMs FROM assets',
      )
      .get()!
    expect(asset).toEqual({ viewCount: 7, watchTimeMs: 42_000 })
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('play_sessions','play_events') ORDER BY name",
      )
      .all()
      .map((row) => row.name)
    expect(tables).toEqual(['play_events', 'play_sessions'])
  })

  test('session creation is retryable through the client session key', () => {
    const db = openSeeded()
    const first = startSession(db)
    expect(first.status).toBe('created')
    const retry = startSession(db, { id: 'session00002' })
    expect(retry.status).toBe('existing')
    expect(retry.status === 'existing' ? retry.session.id : null).toBe('session00001')

    const otherAsset = startSession(db, {
      id: 'session00003',
      assetId: 'asset0002',
      clientSessionKey: 'clientkey01',
    })
    expect(otherAsset.status).toBe('session_key_conflict')
  })

  test('a lost response can be retried without counting watch time twice', () => {
    const db = openSeeded()
    startSession(db)
    const event = {
      eventId: 'event0000001',
      sessionId: 'session00001',
      userId: 'u1',
      seq: 1,
      type: 'watch_time' as const,
      deltaMs: 4_000,
      now: 11_000,
    }

    const first = applyPlayEvent(db, event)
    expect(first).toMatchObject({ status: 'applied', duplicate: false, watchTimeMs: 4_000 })
    const retry = applyPlayEvent(db, event)
    expect(retry).toMatchObject({ status: 'duplicate', duplicate: true, watchTimeMs: 4_000 })
    expect(
      db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM play_events').get()!.n,
    ).toBe(1)

    const changed = applyPlayEvent(db, { ...event, deltaMs: 9_000 })
    expect(changed.status).toBe('event_id_conflict')
    expect(
      db.query<{ watch_time_ms: number }, []>('SELECT watch_time_ms FROM assets').get()!
        .watch_time_ms,
    ).toBe(4_000)
  })

  test('an overtaken sequence is refused and both events apply in order', () => {
    const db = openSeeded()
    startSession(db)
    const base = {
      sessionId: 'session00001',
      userId: 'u1',
      type: 'watch_time' as const,
      now: 11_000,
    }

    const gap = applyPlayEvent(db, { ...base, eventId: 'event0000002', seq: 2, deltaMs: 3_000 })
    expect(gap).toEqual({ status: 'sequence_gap', expectedSeq: 1 })
    expect(
      db.query<{ watch_time_ms: number }, []>('SELECT watch_time_ms FROM assets').get()!
        .watch_time_ms,
    ).toBe(0)

    const first = applyPlayEvent(db, { ...base, eventId: 'event0000001', seq: 1, deltaMs: 3_000 })
    expect(first.status).toBe('applied')
    const second = applyPlayEvent(db, { ...base, eventId: 'event0000002', seq: 2, deltaMs: 3_000 })
    expect(second.status).toBe('applied')
    expect(
      db.query<{ watch_time_ms: number }, []>('SELECT watch_time_ms FROM assets').get()!
        .watch_time_ms,
    ).toBe(6_000)

    const reused = applyPlayEvent(db, {
      ...base,
      eventId: 'event0000003',
      seq: 1,
      deltaMs: 3_000,
    })
    expect(reused.status).toBe('sequence_conflict')
  })

  test('a view is recorded once per play session, not once per event id', () => {
    const db = openSeeded()
    startSession(db)
    const view = { sessionId: 'session00001', userId: 'u1', type: 'view' as const, now: 11_000 }

    expect(applyPlayEvent(db, { ...view, eventId: 'viewevent001', seq: 1 }).status).toBe('applied')
    expect(applyPlayEvent(db, { ...view, eventId: 'viewevent002', seq: 2 }).status).toBe('applied')
    expect(
      db.query<{ view_count: number }, []>('SELECT view_count FROM assets').get()!.view_count,
    ).toBe(1)

    startSession(db, { id: 'session00002', clientSessionKey: 'clientkey02', now: 20_000 })
    expect(
      applyPlayEvent(db, {
        ...view,
        sessionId: 'session00002',
        eventId: 'viewevent003',
        seq: 1,
        now: 21_000,
      }).status,
    ).toBe('applied')
    expect(
      db.query<{ view_count: number }, []>('SELECT view_count FROM assets').get()!.view_count,
    ).toBe(2)
  })

  test('progress stores a versioned position and marks a finished session', () => {
    const db = openSeeded()
    startSession(db)
    const result = applyPlayEvent(db, {
      eventId: 'progressev01',
      sessionId: 'session00001',
      userId: 'u1',
      seq: 1,
      type: 'progress',
      positionMs: 50_000,
      durationMs: 120_000,
      now: 12_000,
    })
    expect(result.status).toBe('applied')
    expect(result.status === 'applied' ? result.progress : null).toMatchObject({
      positionMs: 50_000,
      durationMs: 120_000,
      fileVersion: 1,
      progressVersion: 1,
      lastSessionId: 'session00001',
      lastSeq: 1,
    })

    const finished = applyPlayEvent(db, {
      eventId: 'progressev02',
      sessionId: 'session00001',
      userId: 'u1',
      seq: 2,
      type: 'progress',
      positionMs: 119_000,
      durationMs: 120_000,
      now: 13_000,
    })
    expect(finished.status).toBe('applied')
    expect(getPlaySession(db, 'session00001')!.endedAt).toBe(13_000)
    expect(getProgress(db, 'u1', 'asset0001')!.progressVersion).toBe(2)
  })

  test('a new file version stops the old session from writing progress', () => {
    const db = openSeeded()
    startSession(db)
    const first = applyPlayEvent(db, {
      eventId: 'progressev01',
      sessionId: 'session00001',
      userId: 'u1',
      seq: 1,
      type: 'progress',
      positionMs: 50_000,
      durationMs: 120_000,
      now: 12_000,
    })
    expect(first.status).toBe('applied')

    db.query('UPDATE assets SET file_version = 2 WHERE id = ?').run('asset0001')
    const stale = applyPlayEvent(db, {
      eventId: 'progressev02',
      sessionId: 'session00001',
      userId: 'u1',
      seq: 2,
      type: 'progress',
      positionMs: 60_000,
      durationMs: 120_000,
      now: 13_000,
    })
    expect(stale).toEqual({ status: 'file_version_changed', fileVersion: 2 })
    expect(getProgress(db, 'u1', 'asset0001')!.positionMs).toBe(50_000)

    // The already committed event stays a duplicate even after the change.
    const replay = applyPlayEvent(db, {
      eventId: 'progressev01',
      sessionId: 'session00001',
      userId: 'u1',
      seq: 1,
      type: 'progress',
      positionMs: 50_000,
      durationMs: 120_000,
      now: 12_000,
    })
    expect(replay.status).toBe('duplicate')
  })

  test('legacy progress writes are fenced once a session owns the row', () => {
    const db = openSeeded()
    expect(putProgress(db, 'u1', 'asset0001', 10_000, 120_000, 5_000, 1)).toBe(true)
    expect(getProgress(db, 'u1', 'asset0001')!.positionMs).toBe(10_000)

    startSession(db)
    applyPlayEvent(db, {
      eventId: 'progressev01',
      sessionId: 'session00001',
      userId: 'u1',
      seq: 1,
      type: 'progress',
      positionMs: 70_000,
      durationMs: 120_000,
      now: 12_000,
    })
    expect(putProgress(db, 'u1', 'asset0001', 5_000, 120_000, 13_000, 1)).toBe(false)
    expect(getProgress(db, 'u1', 'asset0001')!.positionMs).toBe(70_000)
  })

  test('a duplicate survives closing and reopening the database', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mv-v20-restart-'))
    dirs.push(dir)
    const file = path.join(dir, 'playback.db')
    const first = openDatabase(file)
    seed(first)
    startSession(first)
    const event = {
      eventId: 'event0000001',
      sessionId: 'session00001',
      userId: 'u1',
      seq: 1,
      type: 'watch_time' as const,
      deltaMs: 4_000,
      now: 11_000,
    }
    expect(applyPlayEvent(first, event).status).toBe('applied')
    first.close()

    const reopened = openDatabase(file)
    expect(applyPlayEvent(reopened, event).status).toBe('duplicate')
    expect(
      reopened.query<{ watch_time_ms: number }, []>('SELECT watch_time_ms FROM assets').get()!
        .watch_time_ms,
    ).toBe(4_000)
    reopened.close()
  })

  test('a deleted asset rejects events and a hard delete removes the session', () => {
    const db = openSeeded()
    startSession(db)
    db.query('UPDATE assets SET deleted_at = ? WHERE id = ?').run(20_000, 'asset0001')
    expect(
      applyPlayEvent(db, {
        eventId: 'event0000001',
        sessionId: 'session00001',
        userId: 'u1',
        seq: 1,
        type: 'view',
        now: 21_000,
      }),
    ).toEqual({ status: 'asset_gone' })

    db.query('DELETE FROM assets WHERE id = ?').run('asset0001')
    expect(getPlaySession(db, 'session00001')).toBeNull()
    expect(
      db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM play_events').get()!.n,
    ).toBe(0)
  })

  test('pruning removes old sessions and their events', () => {
    const db = openSeeded()
    startSession(db)
    applyPlayEvent(db, {
      eventId: 'event0000001',
      sessionId: 'session00001',
      userId: 'u1',
      seq: 1,
      type: 'view',
      now: 11_000,
    })
    expect(prunePlaySessions(db, 11_000)).toBe(1)
    expect(getPlaySession(db, 'session00001')).toBeNull()
    expect(
      db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM play_events').get()!.n,
    ).toBe(0)
  })

  test('vote request ids dedupe a retry but not a second click', () => {
    const db = openSeeded()
    expect(voteAsset(db, 'asset0001', 1000, 'request0001', 'u1')!.voteCount).toBe(1)
    expect(voteAsset(db, 'asset0001', 1001, 'request0001', 'u1')!.voteCount).toBe(1)
    expect(voteAsset(db, 'asset0001', 1002, 'request0002', 'u1')!.voteCount).toBe(2)

    createLibrary(db, { id: 'lib2', name: 'More', rootPath: '/more', createdAt: 1 })
    db.query(
      `INSERT INTO folders (id, library_id, parent_id, relative_path, name, depth, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('folder0002', 'lib2', null, 'Set', 'Set', 0, 1)
    expect(voteFolder(db, 'folder0002', 2000, 'request0001', 'u1')!.voteCount).toBe(1)
    expect(voteFolder(db, 'folder0002', 2001, 'request0001', 'u1')!.voteCount).toBe(1)
    expect(voteFolder(db, 'folder0002', 2002, 'request0002', 'u1')!.voteCount).toBe(2)
  })
})
