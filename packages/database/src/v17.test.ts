import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  claimNextMutation,
  createDeleteMutation,
  createLibrary,
  getFileMutation,
  insertAsset,
  openDatabase,
  releaseMutationLease,
  retryFileMutation,
  transitionMutation,
  upsertFolder,
} from './index'
import { MIGRATIONS, SCHEMA_VERSION } from './schema'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function seedLibrary(db: Database) {
  createLibrary(db, { id: 'lib1', name: 'Media', rootPath: 'Media', createdAt: 1 })
  const folderId = upsertFolder(db, {
    id: 'folder1',
    libraryId: 'lib1',
    parentId: null,
    relativePath: '',
    name: 'Media',
    depth: 0,
    scanId: 'seed',
  })
  insertAsset(db, {
    id: 'asset1',
    libraryId: 'lib1',
    folderId,
    relativePath: 'clip.mp4',
    filename: 'clip.mp4',
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 10,
    mtimeMs: 1,
    width: null,
    height: null,
    durationMs: null,
    takenAt: 1,
    videoCodec: null,
    audioCodec: null,
    container: 'mp4',
    indexedAt: 1,
    scanId: 'seed',
  })
}

function request(db: Database, key = 'key-1') {
  return createDeleteMutation(db, {
    assetId: 'asset1',
    libraryId: 'lib1',
    userId: 'user1',
    requestKey: `user1:${key}`,
    requestedFileVersion: 1,
    sourceRel: 'clip.mp4',
    now: 1000,
  })
}

describe('schema v17 file mutations', () => {
  test('migrates a v16 database and keeps every asset', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mv-v17-'))
    dirs.push(dir)
    const file = path.join(dir, 'legacy.db')

    const legacy = new Database(file)
    legacy.exec('PRAGMA foreign_keys = ON')
    for (let index = 0; index < 16; index += 1) {
      MIGRATIONS[index]!((sql) => legacy.exec(sql))
    }
    legacy.exec('PRAGMA user_version = 16')
    seedLibrary(legacy)
    legacy.close()

    const db = openDatabase(file)
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(
      SCHEMA_VERSION,
    )
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('file_mutations','mutation_events') ORDER BY name",
      )
      .all()
      .map((row) => row.name)
    expect(tables).toEqual(['file_mutations', 'mutation_events'])

    const columns = db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('assets')")
      .all()
      .map((row) => row.name)
    expect(columns).toContain('pending_delete_mutation_id')
    expect(
      db
        .query<{ n: number }, []>(
          'SELECT COUNT(*) AS n FROM assets WHERE deleted_at IS NULL AND pending_delete_mutation_id IS NULL',
        )
        .get()?.n,
    ).toBe(1)
    db.close()
  })

  test('one request key creates one mutation and records one event', () => {
    const db = openDatabase(':memory:')
    seedLibrary(db)
    const first = request(db, 'same')
    const second = request(db, 'same')
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.record.id).toBe(first.record.id)
    expect(
      db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM mutation_events').get()?.n,
    ).toBe(1)
    db.close()
  })

  test('a live lease blocks a second worker and a stale fence cannot write', () => {
    const db = openDatabase(':memory:')
    seedLibrary(db)
    const created = request(db).record

    const first = claimNextMutation(db, 1000, { workerId: 'w1', leaseMs: 60_000 })
    expect(first?.leaseEpoch).toBe(1)
    expect(claimNextMutation(db, 1000, { workerId: 'w2', leaseMs: 60_000 })).toBeNull()

    const second = claimNextMutation(db, 61_001, { workerId: 'w2', leaseMs: 60_000 })
    expect(second?.leaseEpoch).toBe(2)

    const staleWrite = transitionMutation(
      db,
      created.id,
      { workerId: 'w1', leaseEpoch: 1, now: 61_001 },
      { state: 'validated' },
    )
    expect(staleWrite).toBe(false)

    const freshWrite = transitionMutation(
      db,
      created.id,
      { workerId: 'w2', leaseEpoch: 2, now: 61_001 },
      { state: 'validated' },
    )
    expect(freshWrite).toBe(true)
    expect(getFileMutation(db, created.id)?.state).toBe('validated')
    db.close()
  })

  test('a retry requeues only a failed row that no worker holds', () => {
    const db = openDatabase(':memory:')
    seedLibrary(db)
    const created = request(db).record

    const claimed = claimNextMutation(db, 1000, { workerId: 'w1', leaseMs: 60_000 })!
    expect(
      retryFileMutation(db, created.id, 1000),
    ).toBe(false)

    const failed = transitionMutation(
      db,
      created.id,
      { workerId: 'w1', leaseEpoch: claimed.leaseEpoch, now: 1000 },
      {
        state: 'failed_retryable',
        resumeState: 'requested',
        errorCode: 'mutation_failed',
        retryAfter: 2000,
      },
    )
    expect(failed).toBe(true)
    releaseMutationLease(db, created.id, {
      workerId: 'w1',
      leaseEpoch: claimed.leaseEpoch,
      now: 1000,
    })

    expect(retryFileMutation(db, created.id, 1001)).toBe(true)
    const retried = getFileMutation(db, created.id)!
    expect(retried.state).toBe('requested')
    expect(retried.attempts).toBe(0)
    expect(retried.errorCode).toBeNull()
    db.close()
  })
})
