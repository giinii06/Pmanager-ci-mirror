import { describe, expect, test } from 'bun:test'
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  hasActiveJob,
  jobCounts,
  openDatabase,
  recoverRunningJobs,
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
})
