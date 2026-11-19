import { describe, expect, test } from 'bun:test'
import {
  claimNextJob,
  completeJob,
  createLibrary,
  enqueueJob,
  failJob,
  hasActiveJob,
  jobCounts,
  markLibraryFailure,
  markLibraryHealthy,
  openDatabase,
  recoverRunningJobs,
  requeueSourceOfflineJobs,
} from './index'

function freshDb() {
  return openDatabase(':memory:')
}

describe('job queue', () => {
  test('dedupes queued jobs and keeps the highest priority', () => {
    const db = freshDb()
    enqueueJob(db, { dedupeKey: 'thumbnail:a:v1', kind: 'thumbnail', priority: 3 }, 1_000)
    enqueueJob(db, { dedupeKey: 'thumbnail:a:v1', kind: 'thumbnail', priority: 0 }, 2_000)

    expect(jobCounts(db).queued).toBe(1)
    expect(hasActiveJob(db, 'thumbnail:a:v1')).toBe(true)

    const job = claimNextJob(db, 3_000)
    expect(job?.priority).toBe(0)
    expect(job?.attempts).toBe(1)
    db.close()
  })

  test('claims by priority then insertion order', () => {
    const db = freshDb()
    enqueueJob(db, { dedupeKey: 'a', kind: 'thumbnail', priority: 3, assetId: 'a' }, 1_000)
    enqueueJob(db, { dedupeKey: 'b', kind: 'thumbnail', priority: 1, assetId: 'b' }, 1_000)
    enqueueJob(db, { dedupeKey: 'c', kind: 'thumbnail', priority: 1, assetId: 'c' }, 1_000)

    expect(claimNextJob(db, 2_000)?.assetId).toBe('b')
    expect(claimNextJob(db, 2_000)?.assetId).toBe('c')
    expect(claimNextJob(db, 2_000)?.assetId).toBe('a')
    expect(claimNextJob(db, 2_000)).toBeNull()
    db.close()
  })

  test('retries with backoff and fails after maxAttempts', () => {
    const db = freshDb()
    enqueueJob(
      db,
      { dedupeKey: 'hls:x', kind: 'hls', priority: 2, maxAttempts: 2 },
      1_000,
    )

    const first = claimNextJob(db, 2_000)
    expect(first).not.toBeNull()
    failJob(db, first!.id, 'boom', 2_000)

    expect(jobCounts(db).queued).toBe(1)
    expect(claimNextJob(db, 2_500)).toBeNull()

    const second = claimNextJob(db, 3_100)
    expect(second?.attempts).toBe(2)
    expect(second?.lastError).toBe('boom')

    failJob(db, second!.id, 'boom again', 3_200)
    expect(jobCounts(db).failed).toBe(1)
    expect(claimNextJob(db, 10_000)).toBeNull()
    db.close()
  })

  test('a finished job can be enqueued again', () => {
    const db = freshDb()
    enqueueJob(db, { dedupeKey: 'preview:x', kind: 'preview', priority: 2 }, 1_000)
    const job = claimNextJob(db, 1_100)!
    completeJob(db, job.id, 1_200)

    enqueueJob(db, { dedupeKey: 'preview:x', kind: 'preview', priority: 2 }, 1_300)
    expect(jobCounts(db)).toEqual({
      queued: 1,
      running: 0,
      paused: 0,
      cancelled: 0,
      done: 1,
      failed: 0,
    })
    db.close()
  })

  test('recovers jobs left running by a crash', () => {
    const db = freshDb()
    enqueueJob(db, { dedupeKey: 'scan:lib', kind: 'scan_library', priority: 2 }, 1_000)
    claimNextJob(db, 1_100)
    expect(jobCounts(db).running).toBe(1)

    expect(recoverRunningJobs(db, 1_200)).toBe(1)
    expect(jobCounts(db).queued).toBe(1)
    expect(claimNextJob(db, 1_300)?.attempts).toBe(2)
    db.close()
  })

  test('an environment failure parks the row instead of burning retries', () => {
    const db = freshDb()
    enqueueJob(db, { dedupeKey: 'thumb:x', kind: 'thumbnail', priority: 2, maxAttempts: 3 }, 1_000)
    const job = claimNextJob(db, 1_100)!

    expect(failJob(db, job.id, 'the drive is gone', 1_200, undefined, 'SOURCE_OFFLINE')).toBe(true)
    expect(jobCounts(db)).toMatchObject({ queued: 0, failed: 1, running: 0 })

    const row = db
      .query<{ lastError: string }, [number]>('SELECT last_error AS lastError FROM jobs WHERE id = ?')
      .get(job.id)!
    expect(row.lastError).toBe('[SOURCE_OFFLINE] the drive is gone')
    db.close()
  })

  test('a normal failure still retries under the same budget', () => {
    const db = freshDb()
    enqueueJob(db, { dedupeKey: 'thumb:y', kind: 'thumbnail', priority: 2, maxAttempts: 3 }, 1_000)
    const job = claimNextJob(db, 1_100)!

    failJob(db, job.id, 'ffmpeg exited 1', 1_200, undefined, 'INTERNAL')
    expect(jobCounts(db)).toMatchObject({ queued: 1, failed: 0 })
    expect(claimNextJob(db, 10_000)?.attempts).toBe(2)
    db.close()
  })

  test('a long-waiting low-priority job is promoted past a fresher one', () => {
    const db = freshDb()
    enqueueJob(db, { dedupeKey: 'old', kind: 'thumbnail', priority: 2, assetId: 'old' }, 1_000)
    enqueueJob(db, { dedupeKey: 'new', kind: 'thumbnail', priority: 1, assetId: 'new' }, 250_000)

    // Two aging levels (four minutes) lift priority 2 to priority 0.
    expect(claimNextJob(db, 250_000)?.assetId).toBe('old')
    db.close()
  })

  test('an offline-source failure returns once its library is online', () => {
    const db = freshDb()
    createLibrary(db, { id: 'lib1', name: 'Videos', rootPath: 'Videos', createdAt: 1 })
    enqueueJob(
      db,
      { dedupeKey: 'thumb:z', kind: 'thumbnail', priority: 2, libraryId: 'lib1' },
      1_000,
    )
    const job = claimNextJob(db, 1_100)!
    failJob(db, job.id, 'mount is gone', 1_200, undefined, 'SOURCE_OFFLINE')

    markLibraryFailure(db, {
      libraryId: 'lib1',
      state: 'OFFLINE',
      errorCode: 'SOURCE_OFFLINE',
      now: 1_300,
    })
    expect(requeueSourceOfflineJobs(db, 2_000)).toBe(0)

    markLibraryHealthy(db, { libraryId: 'lib1', rootIdentity: null, now: 3_000 })
    expect(requeueSourceOfflineJobs(db, 4_000)).toBe(1)
    expect(jobCounts(db).queued).toBe(1)
    expect(claimNextJob(db, 4_100)?.attempts).toBe(1)
    db.close()
  })

  test('an offline-source failure is not requeued twice', () => {
    const db = freshDb()
    enqueueJob(db, { dedupeKey: 'thumb:w', kind: 'thumbnail', priority: 2 }, 1_000)
    const job = claimNextJob(db, 1_100)!
    failJob(db, job.id, 'mount is gone', 1_200, undefined, 'SOURCE_OFFLINE')

    expect(requeueSourceOfflineJobs(db, 2_000)).toBe(1)
    expect(requeueSourceOfflineJobs(db, 3_000)).toBe(0)
    db.close()
  })

  test('an offline-source failure stays put while a paused row holds its key', () => {
    const db = freshDb()
    db.query(
      `INSERT INTO jobs (dedupe_key, kind, state, priority, last_error, created_at, updated_at)
       VALUES ('thumb:v', 'thumbnail', 'failed', 2, '[SOURCE_OFFLINE] mount is gone', 1_000, 1_100)`,
    ).run()
    db.query(
      `INSERT INTO jobs (dedupe_key, kind, state, priority, created_at, updated_at)
       VALUES ('thumb:v', 'thumbnail', 'paused', 2, 1_200, 1_300)`,
    ).run()

    expect(requeueSourceOfflineJobs(db, 2_000)).toBe(0)
    db.close()
  })

  test('records the API request that asked for the work', () => {
    const db = freshDb()
    enqueueJob(
      db,
      { dedupeKey: 'preview:a:v1', kind: 'preview', priority: 2, requestId: 'req-abc' },
      1_000,
    )
    enqueueJob(db, { dedupeKey: 'thumbnail:b:v1', kind: 'thumbnail', priority: 2 }, 1_000)

    expect(claimNextJob(db, 1_100, { excludeKinds: ['thumbnail'] })?.requestId).toBe('req-abc')
    expect(claimNextJob(db, 1_200, { excludeKinds: ['thumbnail'] })).toBeNull()
    db.close()
  })

  test('excluded kinds stay queued instead of failing', () => {
    const db = freshDb()
    enqueueJob(db, { dedupeKey: 'thumbnail:a:v1', kind: 'thumbnail', priority: 1 }, 1_000)
    enqueueJob(db, { dedupeKey: 'hls:a:v1', kind: 'hls', priority: 2 }, 1_000)
    enqueueJob(db, { dedupeKey: 'scan:lib1', kind: 'scan_library', priority: 3 }, 1_000)

    const claimed = claimNextJob(db, 1_100, { excludeKinds: ['thumbnail', 'hls'] })
    expect(claimed?.kind).toBe('scan_library')
    expect(jobCounts(db).queued).toBe(2)
    expect(jobCounts(db).failed).toBe(0)
    db.close()
  })
})
