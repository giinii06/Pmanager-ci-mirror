import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  cancelJob,
  claimNextJob,
  commitPermanentDelete,
  completeJob,
  createDatabaseBackup,
  createLibrary,
  createTag,
  addTagToAsset,
  enqueueJob,
  failJob,
  getActivityStats,
  getFolder,
  getJob,
  getSqliteRuntimeInfo,
  getVoteActivityStats,
  heartbeatJob,
  incrementAssetView,
  insertAsset,
  listBackupLogs,
  listFolders,
  openDatabase,
  pauseJob,
  pauseRunningJobWithFence,
  recomputeFolderCounts,
  reconcileVoteEvents,
  recoverExpiredJobs,
  restoreDatabaseBackup,
  resumeJob,
  saveJobCheckpoint,
  upsertFolder,
  verifyDatabaseBackup,
  voteAsset,
  voteFolder,
  type Db,
} from './index'

const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('Schema v14 resilience, fencing, middle covers, and orange vote weeds', () => {
  test('enforces synchronous = FULL and monotonic lease_epoch fencing', () => {
    const db = openDatabase(':memory:')
    const info = getSqliteRuntimeInfo(db)
    expect(info.synchronousMode).toBe('FULL')
    expect(info.integrity).toBe('ok')

    enqueueJob(
      db,
      { dedupeKey: 'scan:lib1', kind: 'scan_library', priority: 1, libraryId: 'lib1', progressTotal: 100 },
      1_000,
    )

    const jobA = claimNextJob(db, 1_100, { workerId: 'worker-a', leaseMs: 1_000 })!
    expect(jobA.workerId).toBe('worker-a')
    expect(jobA.leaseEpoch).toBe(1)
    expect(jobA.leaseExpiresAt).toBe(2_100)

    expect(
      saveJobCheckpoint(
        db,
        jobA.id,
        { workerId: 'worker-a', leaseEpoch: 1, now: 1_200 },
        { checkpoint: '{"dir":"sub"}', progressCurrent: 40, phase: 'index' },
      ),
    ).toBe(true)

    // Worker A's lease expires at 2_100; recovery requeues it without burning crash attempts.
    expect(recoverExpiredJobs(db, 2_200)).toBe(1)
    const jobB = claimNextJob(db, 2_300, { workerId: 'worker-b', leaseMs: 5_000 })!
    expect(jobB.workerId).toBe('worker-b')
    expect(jobB.leaseEpoch).toBe(2)
    expect(jobB.attempts).toBe(1)
    expect(jobB.checkpoint).toBe('{"dir":"sub"}')

    // Stale Worker A tries to complete, fail, or heartbeat with old epoch/expiry -> must fail fenced check.
    expect(
      completeJob(db, jobA.id, 2_400, { workerId: 'worker-a', leaseEpoch: 1, now: 2_400 }),
    ).toBe(false)
    expect(
      failJob(db, jobA.id, 'stale err', 2_400, { workerId: 'worker-a', leaseEpoch: 1, now: 2_400 }),
    ).toBe(false)
    expect(
      heartbeatJob(db, jobA.id, { workerId: 'worker-a', leaseEpoch: 1, now: 2_400 }).alive,
    ).toBe(false)

    // Worker B owns the job and finishes cleanly.
    expect(
      completeJob(db, jobB.id, 2_500, { workerId: 'worker-b', leaseEpoch: 2, now: 2_500 }),
    ).toBe(true)
    expect(getJob(db, jobB.id)?.state).toBe('done')
    db.close()
  })

  test('pause preserves checkpoint and reserves dedupe key across recovery and cancel', () => {
    const db = openDatabase(':memory:')
    enqueueJob(db, { dedupeKey: 'scan:libx', kind: 'scan_library', priority: 2, libraryId: 'libx' }, 100)
    const claimed = claimNextJob(db, 200, { workerId: 'w1', leaseMs: 5_000 })!

    pauseJob(db, claimed.id, 300)
    const hb = heartbeatJob(db, claimed.id, { workerId: 'w1', leaseEpoch: 1, now: 350 }, 5_000, {
      checkpoint: '{"dir":"part2"}',
      progressCurrent: 50,
    })
    expect(hb).toEqual({ alive: true, pauseRequested: true, cancelRequested: false })

    expect(
      pauseRunningJobWithFence(db, claimed.id, { workerId: 'w1', leaseEpoch: 1, now: 400 }),
    ).toBe(true)
    expect(getJob(db, claimed.id)?.state).toBe('paused')

    // Enqueueing same dedupe key must NOT create a second job while paused.
    enqueueJob(db, { dedupeKey: 'scan:libx', kind: 'scan_library', priority: 1, libraryId: 'libx' }, 500)
    expect(recoverExpiredJobs(db, 100_000)).toBe(0)
    expect(getJob(db, claimed.id)?.state).toBe('paused')
    expect(claimNextJob(db, 600)).toBeNull()

    resumeJob(db, claimed.id, 700)
    const resumed = claimNextJob(db, 800, { workerId: 'w2', leaseMs: 5_000 })!
    expect(resumed.id).toBe(claimed.id)
    expect(resumed.checkpoint).toBe('{"dir":"part2"}')
    expect(resumed.attempts).toBe(1)

    cancelJob(db, resumed.id, 900)
    expect(
      heartbeatJob(db, resumed.id, { workerId: 'w2', leaseEpoch: 2, now: 950 }, 5_000).cancelRequested,
    ).toBe(true)
    expect(recoverExpiredJobs(db, 10_000)).toBe(1)
    expect(getJob(db, resumed.id)?.state).toBe('cancelled')
    db.close()
  })

  test('picks middle photo cover by filename order and computes folder rate', () => {
    const db = openDatabase(':memory:')
    createLibrary(db, { id: 'lib1', name: 'Photos', rootPath: 'Photos', createdAt: 1 })
    const specs = [
      { id: 'f1', name: 'One', files: [{ name: '01.jpg', w: 100, h: 200 }] },
      {
        id: 'f2',
        name: 'Two',
        files: [
          { name: '01.jpg', w: 100, h: 100 },
          { name: '02.jpg', w: 300, h: 200 },
        ],
      },
      {
        id: 'f4',
        name: 'Four',
        files: [
          { name: 'a.jpg', w: 10, h: 10 },
          { name: 'b.jpg', w: 20, h: 20 },
          { name: 'c.jpg', w: 400, h: 600 },
          { name: 'd.jpg', w: 40, h: 40 },
        ],
      },
      { id: 'f0', name: 'Empty', files: [] },
    ]

    for (const f of specs) {
      upsertFolder(db, {
        id: f.id,
        libraryId: 'lib1',
        parentId: null,
        relativePath: f.name,
        name: f.name,
        depth: 1,
        scanId: 's1',
        createdAt: 100,
      })
      for (const [idx, file] of f.files.entries()) {
        insertAsset(db, {
          id: `${f.id}-${idx}`,
          libraryId: 'lib1',
          folderId: f.id,
          relativePath: `${f.name}/${file.name}`,
          filename: file.name,
          kind: 'image',
          mimeType: 'image/jpeg',
          sizeBytes: 1_000,
          mtimeMs: 1_000,
          width: file.w,
          height: file.h,
          durationMs: null,
          takenAt: 1_000 + idx,
          videoCodec: null,
          audioCodec: null,
          container: 'jpg',
          indexedAt: 1_000,
          scanId: 's1',
        })
      }
    }

    recomputeFolderCounts(db, 'lib1')
    incrementAssetView(db, 'f1-0')
    incrementAssetView(db, 'f1-0')
    incrementAssetView(db, 'f2-0')

    const byId = new Map(listFolders(db, 'lib1').map((f) => [f.id, f]))
    expect(byId.get('f1')).toMatchObject({ coverAssetId: 'f1-0', coverWidth: 100, coverHeight: 200, rate: 75 })
    expect(byId.get('f2')).toMatchObject({ coverAssetId: 'f2-1', coverWidth: 300, coverHeight: 200, rate: 25 })
    expect(byId.get('f4')).toMatchObject({ coverAssetId: 'f4-2', coverWidth: 400, coverHeight: 600, rate: null })
    expect(byId.get('f0')).toMatchObject({ coverAssetId: null, coverWidth: null, coverHeight: null, rate: null })
    db.close()
  })

  test('tracks Vote Orange Weeds independently, reconciles idempotently, and cleans deleted assets', () => {
    const db = openDatabase(':memory:')
    createLibrary(db, { id: 'lib1', name: 'Media', rootPath: 'Media', createdAt: 1 })
    upsertFolder(db, {
      id: 'fp1',
      libraryId: 'lib1',
      parentId: null,
      relativePath: 'Set1',
      name: 'Set1',
      depth: 1,
      scanId: 's1',
      createdAt: 1_700_000_000_000,
    })
    insertAsset(db, {
      id: 'vid1',
      libraryId: 'lib1',
      folderId: 'fp1',
      relativePath: 'clip.mp4',
      filename: 'clip.mp4',
      kind: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 2_000,
      mtimeMs: 1_000,
      width: 640,
      height: 360,
      durationMs: 5_000,
      takenAt: 1_700_000_000_000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      container: 'mp4',
      indexedAt: 1_700_000_000_000,
      scanId: 's1',
    })

    // Simulate pre-v14 existing vote counts without vote_events rows.
    db.exec("UPDATE assets SET vote_count = 2 WHERE id = 'vid1'")
    db.exec("UPDATE folders SET vote_count = 1 WHERE id = 'fp1'")
    expect(reconcileVoteEvents(db)).toBe(3)
    expect(reconcileVoteEvents(db)).toBe(0)

    const now = Date.now()
    voteAsset(db, 'vid1', now)
    voteFolder(db, 'fp1', now)

    const orange = getVoteActivityStats(db, now)
    expect(orange.totalVotes).toBe(5)
    expect(orange.videoVotes).toBe(3)
    expect(orange.folderVotes).toBe(2)

    // Green contribution weeds remain strictly separate (1 standalone video).
    const green = getActivityStats(db, now)
    expect(green.totalCount).toBe(1)

    // Permanent deletion clears asset's vote events cleanly without affecting folder vote events.
    commitPermanentDelete(db, 'vid1', 'lib1')
    const afterDelete = getVoteActivityStats(db, now)
    expect(afterDelete.totalVotes).toBe(2)
    expect(afterDelete.folderVotes).toBe(2)
    expect(getFolder(db, 'fp1')?.voteCount).toBe(2)
    db.close()
  })

  test('creates verified VACUUM INTO backups, enforces retention, and restores cleanly', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mv-v14-backup-'))
    tempDirs.push(dir)
    const mainDbPath = path.join(dir, 'main.db')
    const backupDir = path.join(dir, 'backups')
    const restoredPath = path.join(dir, 'restored.db')

    const db: Db = openDatabase(mainDbPath)
    createLibrary(db, { id: 'lib1', name: 'Media', rootPath: 'Media', createdAt: 1 })
    upsertFolder(db, {
      id: 'f1',
      libraryId: 'lib1',
      parentId: null,
      relativePath: 'Set1',
      name: 'Set1',
      depth: 1,
      scanId: 's1',
    })
    insertAsset(db, {
      id: 'a1',
      libraryId: 'lib1',
      folderId: 'f1',
      relativePath: 'Set1/01.jpg',
      filename: '01.jpg',
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 500,
      mtimeMs: 1_000,
      width: 100,
      height: 100,
      durationMs: null,
      takenAt: 1_000,
      videoCodec: null,
      audioCodec: null,
      container: 'jpg',
      indexedAt: 1_000,
      scanId: 's1',
    })
    createTag(db, 'tag1', 'Fav', 1_000)
    addTagToAsset(db, 'a1', 'tag1', 1_000)
    voteAsset(db, 'a1', 1_000)

    const b1 = createDatabaseBackup(db, backupDir, { retentionCount: 2, now: 1_000 })
    const b2 = createDatabaseBackup(db, backupDir, { retentionCount: 2, now: 2_000 })
    const b3 = createDatabaseBackup(db, backupDir, { retentionCount: 2, now: 3_000 })
    expect(b1.integrity).toBe('ok')
    expect(b3.sizeBytes).toBeGreaterThan(0)
    expect(readdirSync(backupDir).filter((n) => n.endsWith('.db'))).toHaveLength(2)
    expect(listBackupLogs(db)).toHaveLength(3)

    const verified = verifyDatabaseBackup(path.join(backupDir, b2.filename))
    expect(verified).toEqual({ integrity: 'ok', assets: 1, folders: 1, tags: 1, voteEvents: 1 })

    const restored = restoreDatabaseBackup(path.join(backupDir, b3.filename), restoredPath)
    expect(restored).toEqual({ integrity: 'ok', assets: 1, folders: 1, tags: 1, voteEvents: 1 })
    db.close()
  })
})
