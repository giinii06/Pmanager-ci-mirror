import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  claimNextJob,
  countUnread,
  createLibrary,
  createUser,
  enqueueJob,
  insertAsset,
  openDatabase,
  recordCacheCleanupRun,
  recordDiagnosticsRun,
  recordWorkerHeartbeat,
  upsertFolder,
  upsertNotification,
} from './index'
import { MIGRATIONS, SCHEMA_VERSION } from './schema'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function seed(legacy: Database): void {
  createUser(legacy, { id: 'u1', username: 'owner', passwordHash: 'h', createdAt: 1 })
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
  insertAsset(legacy, {
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

describe('schema v25 observability', () => {
  test('migrates a v24 database, keeps its rows, and adds the observability tables', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mv-v25-'))
    dirs.push(dir)
    const file = path.join(dir, 'legacy.db')

    const legacy = new Database(file)
    legacy.exec('PRAGMA foreign_keys = ON')
    for (let index = 0; index < 24; index += 1) {
      MIGRATIONS[index]!((sql) => legacy.exec(sql))
    }
    legacy.exec('PRAGMA user_version = 24')
    seed(legacy)
    legacy.close()

    const db = openDatabase(file)
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(
      SCHEMA_VERSION,
    )
    expect(SCHEMA_VERSION).toBe(25)

    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'notifications','notification_delivery_attempts','diagnostics_runs',
           'worker_heartbeats','cache_cleanup_runs'
         ) ORDER BY name`,
      )
      .all()
      .map((row) => row.name)
    expect(tables).toEqual([
      'cache_cleanup_runs',
      'diagnostics_runs',
      'notification_delivery_attempts',
      'notifications',
      'worker_heartbeats',
    ])

    const indexes = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (
           'ux_notifications_active_dedupe','idx_notifications_state_seen','idx_delivery_due',
           'idx_diagnostics_runs_created','idx_worker_heartbeats_seen',
           'idx_cache_cleanup_runs_created','idx_jobs_request'
         ) ORDER BY name`,
      )
      .all()
      .map((row) => row.name)
    expect(indexes).toEqual([
      'idx_cache_cleanup_runs_created',
      'idx_delivery_due',
      'idx_diagnostics_runs_created',
      'idx_jobs_request',
      'idx_notifications_state_seen',
      'idx_worker_heartbeats_seen',
      'ux_notifications_active_dedupe',
    ])

    const jobColumns = db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('jobs')")
      .all()
      .map((row) => row.name)
    expect(jobColumns).toContain('request_id')

    expect(
      db
        .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM assets WHERE deleted_at IS NULL')
        .get()?.n,
    ).toBe(1)

    enqueueJob(
      db,
      { dedupeKey: 'thumbnail:asset1:v1', kind: 'thumbnail', priority: 2, requestId: 'req-1' },
      100,
    )
    expect(claimNextJob(db, 200)?.requestId).toBe('req-1')

    upsertNotification(
      db,
      {
        kind: 'db_integrity',
        severity: 'critical',
        dedupeKey: 'db:integrity',
        title: 'Integrity check failed',
        body: 'quick_check returned a row',
      },
      300,
      60_000,
    )
    expect(countUnread(db)).toBe(1)

    recordWorkerHeartbeat(db, {
      instanceId: 'boot-a',
      workerId: 'worker-1',
      component: 'media',
      pid: 1,
      state: 'idle',
      now: 400,
    })
    recordDiagnosticsRun(db, { id: 'diag1', userId: 'u1', format: 'json', sizeBytes: 12, now: 500 })
    recordCacheCleanupRun(db, {
      id: 'clean1',
      userId: 'u1',
      types: ['thumbs'],
      candidateBytes: 100,
      deletedBytes: 80,
      deletedFiles: 2,
      now: 600,
    })

    db.query<null, [string]>('DELETE FROM users WHERE id = ?').run('u1')
    const audit = db
      .query<{ userId: string | null }, []>('SELECT user_id AS userId FROM diagnostics_runs')
      .get()
    expect(audit?.userId).toBeNull()
    db.close()
  })
})
