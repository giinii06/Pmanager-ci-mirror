import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PRIORITY } from '@mediavault/shared'
import {
  claimHlsGeneration,
  claimNextJob,
  createHlsRequest,
  createLibrary,
  failHlsGeneration,
  failOrphanedHlsGenerations,
  getHlsActive,
  getHlsGeneration,
  insertAsset,
  listHlsGcCandidates,
  markHlsGenerationDeleting,
  markHlsGenerationRemoved,
  openDatabase,
  publishHlsGeneration,
  updateAssetFile,
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

function request(db: Database, profile = 'profile-a', now = 1_000) {
  return createHlsRequest(db, {
    assetId: 'asset1',
    fileVersion: 1,
    profileHash: profile,
    priority: PRIORITY.now,
    now,
  })
}

function claimJob(db: Database, workerId = 'w1', leaseMs = 60_000, now = 2_000) {
  const job = claimNextJob(db, now, { workerId, leaseMs })
  if (!job) throw new Error('no job to claim')
  return job
}

function fence(job: ReturnType<typeof claimJob>, now = 2_100) {
  return { workerId: 'w1', leaseEpoch: job.leaseEpoch, jobId: job.id, now }
}

describe('schema v18 HLS generations', () => {
  test('migrates a v17 database and keeps every asset', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mv-v18-'))
    dirs.push(dir)
    const file = path.join(dir, 'legacy.db')

    const legacy = new Database(file)
    legacy.exec('PRAGMA foreign_keys = ON')
    for (let index = 0; index < 17; index += 1) {
      MIGRATIONS[index]!((sql) => legacy.exec(sql))
    }
    legacy.exec('PRAGMA user_version = 17')
    seedLibrary(legacy)
    legacy.close()

    const db = openDatabase(file)
    expect(
      db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version,
    ).toBe(SCHEMA_VERSION)
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM assets').get()!.n).toBe(1)
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('hls_generations','hls_active') ORDER BY name",
      )
      .all()
      .map((row) => row.name)
    expect(tables).toEqual(['hls_active', 'hls_generations'])
    const trigger = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_assets_version_clears_hls_active'",
      )
      .get()
    expect(trigger?.name).toBe('trg_assets_version_clears_hls_active')
    db.close()
  })

  test('one asset/version/profile has one pending request and one job', () => {
    const db = openDatabase(':memory:')
    seedLibrary(db)

    const first = request(db)
    const again = request(db, 'profile-a', 1_500)
    expect(first.created).toBe(true)
    expect(again.created).toBe(false)
    expect(again.generation.id).toBe(first.generation.id)
    expect(again.generation.state).toBe('queued')
    expect(again.generation.jobId).toBe(first.generation.jobId)
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'hls'").get()!.n).toBe(1)

    const other = request(db, 'profile-b')
    expect(other.created).toBe(true)
    expect(other.generation.id).not.toBe(first.generation.id)
    db.close()
  })

  test('a pending generation whose job died gets a new job', () => {
    const db = openDatabase(':memory:')
    seedLibrary(db)
    const created = request(db)
    db.query('UPDATE jobs SET state = \'failed\' WHERE id = ?').run(created.generation.jobId!)

    const again = request(db, 'profile-a', 2_000)
    expect(again.created).toBe(false)
    expect(again.generation.id).toBe(created.generation.id)
    expect(again.generation.jobId).not.toBe(created.generation.jobId)
    const job = db
      .query<{ state: string }, [number]>('SELECT state FROM jobs WHERE id = ?')
      .get(again.generation.jobId!)
    expect(job?.state).toBe('queued')
    db.close()
  })

  test('publication requires the live job lease and the same asset version', () => {
    const db = openDatabase(':memory:')
    seedLibrary(db)
    const created = request(db)
    const job = claimJob(db)
    expect(claimHlsGeneration(db, created.generation.id, fence(job))).toBe(true)

    const published = publishHlsGeneration(db, {
      id: created.generation.id,
      fence: fence(job),
      storageRel: 'hls/asset1/v1/g/gen-attempt',
      playlistRel: 'hls/asset1/v1/g/gen-attempt/master.m3u8',
      encoder: 'libx264',
      graceMs: 1_000,
    })
    expect(published).toEqual({ published: true, activated: true })
    expect(getHlsGeneration(db, created.generation.id)!.state).toBe('ready')
    expect(getHlsActive(db, 'asset1', 1, 'profile-a')!.generationId).toBe(created.generation.id)

    // A second generation for the same scope is created only after the first
    // fails; a stale publish of the failed one must not activate.
    const failed = request(db, 'profile-c')
    const failedJob = claimJob(db, 'w2', 60_000, 3_000)
    const failedFence = { workerId: 'w2', leaseEpoch: failedJob.leaseEpoch, jobId: failedJob.id, now: 3_100 }
    expect(claimHlsGeneration(db, failed.generation.id, failedFence)).toBe(true)
    expect(
      failHlsGeneration(db, failed.generation.id, failedFence, {
        state: 'failed',
        errorCode: 'encode_failed',
        errorMessage: 'boom',
      }),
    ).toBe(true)
    expect(
      publishHlsGeneration(db, {
        id: failed.generation.id,
        fence: failedFence,
        storageRel: 'hls/asset1/v1/g/late',
        playlistRel: 'hls/asset1/v1/g/late/master.m3u8',
        encoder: 'libx264',
        graceMs: 1_000,
      }),
    ).toEqual({ published: false, activated: false })
    db.close()
  })

  test('an expired job lease cannot publish', () => {
    const db = openDatabase(':memory:')
    seedLibrary(db)
    const created = request(db)
    const job = claimJob(db, 'w1', 1_000, 2_000)
    const live = { workerId: 'w1', leaseEpoch: job.leaseEpoch, jobId: job.id, now: 2_100 }
    expect(claimHlsGeneration(db, created.generation.id, live)).toBe(true)

    const expired = { ...live, now: 3_500 }
    expect(
      publishHlsGeneration(db, {
        id: created.generation.id,
        fence: expired,
        storageRel: 'hls/asset1/v1/g/late',
        playlistRel: 'hls/asset1/v1/g/late/master.m3u8',
        encoder: 'libx264',
        graceMs: 1_000,
      }),
    ).toEqual({ published: false, activated: false })
    expect(getHlsGeneration(db, created.generation.id)!.state).toBe('running')
    db.close()
  })

  test('a file version change refuses publication and clears old active rows', () => {
    const db = openDatabase(':memory:')
    seedLibrary(db)
    const created = request(db)
    const job = claimJob(db)
    expect(claimHlsGeneration(db, created.generation.id, fence(job))).toBe(true)

    const folderId = db.query<{ id: string }, []>('SELECT id FROM folders LIMIT 1').get()!.id
    updateAssetFile(db, 'asset1', {
      folderId,
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 10,
      mtimeMs: 2,
      width: null,
      height: null,
      durationMs: null,
      takenAt: 1,
      videoCodec: null,
      audioCodec: null,
      container: 'mp4',
      indexedAt: 2,
      scanId: 'scan-2',
    })

    expect(
      publishHlsGeneration(db, {
        id: created.generation.id,
        fence: fence(job),
        storageRel: 'hls/asset1/v1/g/late',
        playlistRel: 'hls/asset1/v1/g/late/master.m3u8',
        encoder: 'libx264',
        graceMs: 1_000,
      }),
    ).toEqual({ published: false, activated: false })
    expect(getHlsActive(db, 'asset1', 1, 'profile-a')).toBeNull()
    db.close()
  })

  test('a newer request sequence cannot be displaced by a late older publish', () => {
    const db = openDatabase(':memory:')
    seedLibrary(db)
    const older = request(db, 'profile-a')
    const job = claimJob(db)
    expect(claimHlsGeneration(db, older.generation.id, fence(job))).toBe(true)

    // Simulate a newer generation that already won this scope.
    db.query(
      `INSERT INTO hls_generations (
         id, asset_id, file_version, profile_hash, state, request_seq, created_at, updated_at
       ) VALUES ('newer', 'asset1', 1, 'profile-a', 'ready', 99, 5000, 5000)`,
    ).run()
    db.query(
      `INSERT INTO hls_active (
         asset_id, file_version, profile_hash, generation_id, request_seq, updated_at
       ) VALUES ('asset1', 1, 'profile-a', 'newer', 99, 5000)`,
    ).run()

    expect(
      publishHlsGeneration(db, {
        id: older.generation.id,
        fence: fence(job),
        storageRel: 'hls/asset1/v1/g/old',
        playlistRel: 'hls/asset1/v1/g/old/master.m3u8',
        encoder: 'libx264',
        graceMs: 1_000,
      }),
    ).toEqual({ published: true, activated: false })
    expect(getHlsActive(db, 'asset1', 1, 'profile-a')!.generationId).toBe('newer')
    expect(getHlsGeneration(db, older.generation.id)!.eligibleForGcAt).not.toBeNull()
    db.close()
  })

  test('GC never takes the active generation and marks victims before removal', () => {
    const db = openDatabase(':memory:')
    seedLibrary(db)
    const created = request(db)
    const job = claimJob(db)
    expect(claimHlsGeneration(db, created.generation.id, fence(job))).toBe(true)
    publishHlsGeneration(db, {
      id: created.generation.id,
      fence: fence(job),
      storageRel: 'hls/asset1/v1/g/a',
      playlistRel: 'hls/asset1/v1/g/a/master.m3u8',
      encoder: 'libx264',
      graceMs: 1_000,
    })

    db.query('UPDATE hls_generations SET eligible_for_gc_at = 1 WHERE id = ?').run(created.generation.id)
    expect(listHlsGcCandidates(db, 10_000, 0)).toHaveLength(0)
    expect(markHlsGenerationDeleting(db, created.generation.id)).toBe(false)

    // Supersede it, then the same row becomes a candidate.
    db.query(
      `INSERT INTO hls_generations (
         id, asset_id, file_version, profile_hash, state, request_seq, created_at, updated_at
       ) VALUES ('next', 'asset1', 1, 'profile-a', 'ready', 2, 6000, 6000)`,
    ).run()
    db.query(
      `UPDATE hls_active SET generation_id = 'next', request_seq = 2, updated_at = 6000
       WHERE asset_id = 'asset1' AND file_version = 1 AND profile_hash = 'profile-a'`,
    ).run()
    expect(listHlsGcCandidates(db, 10_000, 0)).toHaveLength(1)
    expect(markHlsGenerationDeleting(db, created.generation.id)).toBe(true)
    expect(getHlsGeneration(db, created.generation.id)!.state).toBe('deleting')
    expect(markHlsGenerationRemoved(db, created.generation.id)).toBe(true)
    expect(getHlsGeneration(db, created.generation.id)!.storageRel).toBeNull()
    db.close()
  })

  test('a generation whose job is gone is failed by reconciliation', () => {
    const db = openDatabase(':memory:')
    seedLibrary(db)
    const created = request(db)
    db.query("UPDATE jobs SET state = 'failed' WHERE id = ?").run(created.generation.jobId!)

    expect(failOrphanedHlsGenerations(db)).toBe(1)
    const generation = getHlsGeneration(db, created.generation.id)!
    expect(generation.state).toBe('failed')
    expect(generation.errorCode).toBe('orphaned')
    db.close()
  })
})
