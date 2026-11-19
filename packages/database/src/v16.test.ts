import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createLibrary,
  getLibraryHealth,
  getLatestScanRun,
  insertAsset,
  listLibraryHealth,
  markLibraryFailure,
  markLibraryHealthy,
  markLibraryVerified,
  openDatabase,
  updateScanRun,
  upsertFolder,
  type NewAsset,
} from './index'
import { MIGRATIONS, SCHEMA_VERSION } from './schema'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function legacyAsset(folderId: string): NewAsset {
  return {
    id: 'asset1',
    libraryId: 'lib1',
    folderId,
    relativePath: 'photo.jpg',
    filename: 'photo.jpg',
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 10,
    mtimeMs: 1,
    width: 4,
    height: 4,
    durationMs: null,
    takenAt: 1,
    videoCodec: null,
    audioCodec: null,
    container: null,
    indexedAt: 1,
    scanId: 'seed',
  }
}

describe('schema v16 library health', () => {
  test('migrates a v15 database, keeps data, and backfills health from the last completed scan', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mv-v16-'))
    dirs.push(dir)
    const file = path.join(dir, 'legacy.db')

    const legacy = new Database(file)
    legacy.exec('PRAGMA foreign_keys = ON')
    for (let index = 0; index < 15; index += 1) {
      MIGRATIONS[index]!((sql) => legacy.exec(sql))
    }
    legacy.exec('PRAGMA user_version = 15')
    createLibrary(legacy, { id: 'lib1', name: 'Media', rootPath: 'Media', createdAt: 1 })
    const folderId = upsertFolder(legacy, {
      id: 'folder1',
      libraryId: 'lib1',
      parentId: null,
      relativePath: '',
      name: 'Media',
      depth: 0,
      scanId: 'seed',
    })
    insertAsset(legacy, legacyAsset(folderId))
    legacy
      .query(
        `INSERT INTO scan_runs (
           id, library_id, root_path, phase, status, files_seen,
           started_at, updated_at, completed_at
         ) VALUES (?, ?, ?, 'completed', 'completed', 1, 1000, 1000, 1000)`,
      )
      .run('run1', 'lib1', 'Media')
    legacy.close()

    const db = openDatabase(file)
    const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()
    expect(version?.user_version).toBe(SCHEMA_VERSION)
    expect(SCHEMA_VERSION).toBe(16)

    const health = getLibraryHealth(db, 'lib1')
    expect(health).toMatchObject({
      libraryId: 'lib1',
      state: 'ONLINE',
      lastSuccessAt: 1000,
      lastErrorCode: null,
      consecutiveFailures: 0,
    })
    expect(
      db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM assets').get()?.n,
    ).toBe(1)
    expect(
      db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM folders').get()?.n,
    ).toBe(1)
    db.close()
  })

  test('records failures, resets on success, and keeps last_success_at on verify', () => {
    const db = openDatabase(':memory:')
    createLibrary(db, { id: 'lib1', name: 'Media', rootPath: 'Media', createdAt: 1 })

    markLibraryHealthy(db, { libraryId: 'lib1', rootIdentity: 'dev:1', now: 1000 })
    markLibraryFailure(db, {
      libraryId: 'lib1',
      state: 'OFFLINE',
      errorCode: 'root_missing',
      now: 2000,
    })
    expect(getLibraryHealth(db, 'lib1')).toMatchObject({
      state: 'OFFLINE',
      rootIdentity: 'dev:1',
      lastSuccessAt: 1000,
      lastErrorCode: 'root_missing',
      consecutiveFailures: 1,
    })

    markLibraryFailure(db, {
      libraryId: 'lib1',
      state: 'DEGRADED',
      errorCode: 'read_errors',
      now: 3000,
    })
    expect(getLibraryHealth(db, 'lib1')?.consecutiveFailures).toBe(2)

    markLibraryVerified(db, { libraryId: 'lib1', rootIdentity: 'dev:1', now: 4000 })
    expect(getLibraryHealth(db, 'lib1')).toMatchObject({
      state: 'ONLINE',
      lastSuccessAt: 1000,
      lastErrorCode: null,
      consecutiveFailures: 0,
    })

    markLibraryHealthy(db, { libraryId: 'lib1', rootIdentity: 'dev:1', now: 5000 })
    expect(getLibraryHealth(db, 'lib1')?.lastSuccessAt).toBe(5000)
    expect(listLibraryHealth(db)).toHaveLength(1)
    db.close()
  })

  test('scan runs carry mount identity and deletion counters', () => {
    const db = openDatabase(':memory:')
    createLibrary(db, { id: 'lib1', name: 'Media', rootPath: 'Media', createdAt: 1 })
    db.query(
      `INSERT INTO scan_runs (id, library_id, root_path, phase, status, started_at, updated_at)
       VALUES ('run1', 'lib1', 'Media', 'discover', 'running', 1, 1)`,
    ).run()
    updateScanRun(db, 'run1', {
      mountIdentity: 'dev:1',
      missingCount: 3,
      missingRatio: 0.3,
      authoritativeVerified: 1,
      healthState: 'ONLINE',
      updatedAt: 2,
    })

    const scan = getLatestScanRun(db, 'lib1')
    expect(scan).toMatchObject({
      mountIdentity: 'dev:1',
      missingCount: 3,
      missingRatio: 0.3,
      authoritativeVerified: 1,
      healthState: 'ONLINE',
    })
    db.close()
  })
})
