import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import {
  claimNextJob,
  completeJob,
  countAssets,
  createDatabaseBackup,
  createLibrary,
  enqueueJob,
  getJob,
  getLatestRecoveryLog,
  getScanCheckpoint,
  insertAsset,
  openDatabase,
  pauseJob,
  requeueInterruptedJobWithFence,
  restoreDatabaseBackup,
  upsertFolder,
  type Db,
} from '@mediavault/database'
import { thumbnailPath } from '@mediavault/media'
import { PRIORITY, THUMBNAIL_SIZES } from '@mediavault/shared'
import type { WorkerConfig } from './config'
import { executeJob } from './handlers'
import { runWorkerRecovery } from './recovery'
import { scanLibrary } from './scan'

function getLatestScanRunRow(db: Db, libraryId: string): { status: string; resumedFromRunId: string | null } | null {
  return (
    db
      .query<{ status: string; resumedFromRunId: string | null }, [string]>(
        'SELECT status, resumed_from_run_id AS resumedFromRunId FROM scan_runs WHERE library_id = ? ORDER BY started_at DESC LIMIT 1',
      )
      .get(libraryId) ?? null
  )
}

const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function makeTempConfig(): Promise<{ dir: string; config: WorkerConfig }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-crash-rec-'))
  dirs.push(dir)
  const mediaRoot = path.join(dir, 'media')
  const cacheDir = path.join(dir, 'cache')
  await mkdir(mediaRoot, { recursive: true })
  await mkdir(cacheDir, { recursive: true })
  return {
    dir,
    config: {
      dataDir: dir,
      cacheDir,
      mediaRoot,
      hwaccel: null,
      pollMs: 50,
      once: true,
      gpuResource: 'gpu:0',
      workerId: 'worker-a',
      scanDeleteGuardRatio: 0.2,
      scanDeleteForce: false,
      staleTempAgeMs: 60_000,
    },
  }
}

async function sampleJpegBuffer(): Promise<Buffer> {
  return sharp({
    create: { width: 32, height: 24, channels: 3, background: { r: 210, g: 110, b: 40 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer()
}

describe('crash recovery & durability release gates', () => {
  test('resumes 1,000-file interrupted scan across offline add/move/delete with 100% fidelity', async () => {
    const { dir, config } = await makeTempConfig()
    const libRoot = path.join(config.mediaRoot, 'Gallery')
    const refRoot = path.join(config.mediaRoot, 'RefGallery')
    const jpg = await sampleJpegBuffer()

    for (let i = 0; i < 1000; i += 1) {
      const folder = `folder-${String(Math.floor(i / 50)).padStart(2, '0')}`
      const name = `img-${String(i).padStart(4, '0')}.jpg`
      const d1 = path.join(libRoot, folder)
      const d2 = path.join(refRoot, folder)
      if (i % 50 === 0) {
        await mkdir(d1, { recursive: true })
        await mkdir(d2, { recursive: true })
      }
      await writeFile(path.join(d1, name), jpg)
      await writeFile(path.join(d2, name), jpg)
    }

    const db = openDatabase(path.join(dir, 'mediavault.db'))
    createLibrary(db, { id: 'lib1', name: 'Gallery', rootPath: 'Gallery', createdAt: 100 })
    createLibrary(db, { id: 'lib-ref', name: 'RefGallery', rootPath: 'RefGallery', createdAt: 100 })

    const controller = new AbortController()
    let batchesSeen = 0
    await expect(
      scanLibrary(db, config, 'lib1', {
        signal: controller.signal,
        onBatchCommitted: (count) => {
          batchesSeen += 1
          if (count >= 500) controller.abort('paused')
        },
      }),
    ).rejects.toThrow()

    expect(batchesSeen).toBeGreaterThanOrEqual(2)
    const checkpoint = getScanCheckpoint(db, 'lib1')
    expect(checkpoint).not.toBeNull()
    expect(checkpoint!.processedFiles).toBeGreaterThanOrEqual(500)

    const interruptedRun = getLatestScanRunRow(db, 'lib1')
    expect(interruptedRun?.status).toBe('paused')

    // Offline churn behind and across the checkpoint cursor on both libraries:
    // 1. Delete an already-indexed file in folder-00.
    await rm(path.join(libRoot, 'folder-00/img-0005.jpg'))
    await rm(path.join(refRoot, 'folder-00/img-0005.jpg'))
    // 2. Add a brand new file in folder-00 (strictly behind cursor).
    await writeFile(path.join(libRoot, 'folder-00/000-added-before-cursor.jpg'), jpg)
    await writeFile(path.join(refRoot, 'folder-00/000-added-before-cursor.jpg'), jpg)
    // 3. Move a file from folder-19 (after cursor) to folder-01 (before cursor).
    await rename(
      path.join(libRoot, 'folder-19/img-0999.jpg'),
      path.join(libRoot, 'folder-01/001-moved-before-cursor.jpg'),
    )
    await rename(
      path.join(refRoot, 'folder-19/img-0999.jpg'),
      path.join(refRoot, 'folder-01/001-moved-before-cursor.jpg'),
    )

    const resumed = await scanLibrary(db, config, 'lib1')
    expect(resumed.files).toBe(1000)
    expect(getScanCheckpoint(db, 'lib1')).toBeNull()
    const completedRun = getLatestScanRunRow(db, 'lib1')
    expect(completedRun?.status).toBe('completed')
    expect(completedRun?.resumedFromRunId).toBe(checkpoint!.scanId)

    await scanLibrary(db, config, 'lib-ref')

    const liveAssets = db
      .query<{ relativePath: string; sizeBytes: number }, []>(
        "SELECT relative_path AS relativePath, size_bytes AS sizeBytes FROM assets WHERE library_id = 'lib1' AND deleted_at IS NULL ORDER BY relative_path ASC",
      )
      .all()
    const refAssets = db
      .query<{ relativePath: string; sizeBytes: number }, []>(
        "SELECT relative_path AS relativePath, size_bytes AS sizeBytes FROM assets WHERE library_id = 'lib-ref' AND deleted_at IS NULL ORDER BY relative_path ASC",
      )
      .all()

    expect(liveAssets).toHaveLength(1000)
    expect(liveAssets).toEqual(refAssets)
    expect(liveAssets.some((a) => a.relativePath === 'folder-00/000-added-before-cursor.jpg')).toBe(true)
    expect(liveAssets.some((a) => a.relativePath === 'folder-01/001-moved-before-cursor.jpg')).toBe(true)
    expect(liveAssets.some((a) => a.relativePath === 'folder-00/img-0005.jpg')).toBe(false)
    expect(liveAssets.some((a) => a.relativePath === 'folder-19/img-0999.jpg')).toBe(false)
    db.close()
  })

  test('worker recovery cleans stale .tmp, fences expired thumbnail lease, and completes cleanly on worker B', async () => {
    const { dir, config } = await makeTempConfig()
    const libRoot = path.join(config.mediaRoot, 'Pics')
    await mkdir(libRoot, { recursive: true })
    const imgPath = path.join(libRoot, 'photo.jpg')
    const jpg = await sampleJpegBuffer()
    await writeFile(imgPath, jpg)

    const db = openDatabase(path.join(dir, 'workers.db'))
    createLibrary(db, { id: 'lib1', name: 'Pics', rootPath: 'Pics', createdAt: 1 })
    const fId = upsertFolder(db, {
      id: 'f1',
      libraryId: 'lib1',
      parentId: null,
      relativePath: '',
      name: 'Pics',
      depth: 0,
      scanId: 's1',
    })
    insertAsset(db, {
      id: 'asset001',
      libraryId: 'lib1',
      folderId: fId,
      relativePath: 'photo.jpg',
      filename: 'photo.jpg',
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: jpg.length,
      mtimeMs: Date.now(),
      width: 32,
      height: 24,
      durationMs: null,
      takenAt: Date.now(),
      videoCodec: null,
      audioCodec: null,
      container: 'jpg',
      indexedAt: Date.now(),
      scanId: 's1',
    })

    const baseNow = Date.now()
    enqueueJob(
      db,
      { dedupeKey: 'thumb:asset001:1', kind: 'thumbnail', priority: PRIORITY.now, assetId: 'asset001' },
      baseNow,
    )

    const claimA = claimNextJob(db, baseNow, { workerId: 'worker-a', leaseMs: 10_000 })
    expect(claimA).not.toBeNull()
    expect(claimA!.leaseEpoch).toBe(1)

    const staleTmp = path.join(config.cacheDir, 'thumbs', 'stale.tmp')
    await mkdir(path.dirname(staleTmp), { recursive: true })
    await writeFile(staleTmp, 'partial')
    const oldTime = new Date(baseNow - 300_000)
    await utimes(staleTmp, oldTime, oldTime)

    // Lease expired at baseNow + 10_000; run recovery at baseNow + 200_000.
    const recovery = await runWorkerRecovery(db, config, { now: baseNow + 200_000, reconcileThumbs: true })
    expect(recovery.recoveredJobs).toBe(1)
    expect(recovery.cleanedTempFiles).toBe(1)
    expect(recovery.dbIntegrity).toBe('ok')
    expect(getLatestRecoveryLog(db)?.cleanedTempFiles).toBe(1)

    const claimB = claimNextJob(db, baseNow + 200_100, { workerId: 'worker-b', leaseMs: 30_000 })
    expect(claimB).not.toBeNull()
    expect(claimB!.id).toBe(claimA!.id)
    expect(claimB!.leaseEpoch).toBe(2)

    // Worker A holds stale epoch 1: fence prevents completing or overwriting job state.
    expect(
      completeJob(db, claimA!.id, baseNow + 200_200, {
        workerId: 'worker-a',
        leaseEpoch: 1,
        now: baseNow + 200_200,
      }),
    ).toBe(false)
    expect(getJob(db, claimB!.id)?.state).toBe('running')

    await executeJob(db, config, claimB!, {
      fence: { jobId: claimB!.id, workerId: 'worker-b', leaseEpoch: claimB!.leaseEpoch, leaseMs: 30_000 },
    })
    expect(
      completeJob(db, claimB!.id, baseNow + 200_300, {
        workerId: 'worker-b',
        leaseEpoch: 2,
        now: baseNow + 200_300,
      }),
    ).toBe(true)
    expect(getJob(db, claimB!.id)?.state).toBe('done')

    const thumbOut = thumbnailPath(config.cacheDir, 'asset001', 1, THUMBNAIL_SIZES[0])
    expect(await Bun.file(thumbOut).exists()).toBe(true)
    db.close()
  })

  test('paused job remains paused across recovery and requeued shutdown job resumes safely', async () => {
    const { dir, config } = await makeTempConfig()
    const db = openDatabase(path.join(dir, 'pause.db'))

    enqueueJob(db, { dedupeKey: 'scan:lib1', kind: 'scan_library', priority: 2, libraryId: 'lib1' }, 100)
    const job1 = claimNextJob(db, 100, { workerId: 'w1', leaseMs: 5_000 })!
    expect(requeueInterruptedJobWithFence(db, job1.id, { workerId: 'w1', leaseEpoch: job1.leaseEpoch, now: 200 })).toBe(
      true,
    )
    expect(getJob(db, job1.id)?.state).toBe('queued')

    const paused = pauseJob(db, job1.id, 300)
    expect(paused?.state).toBe('paused')

    // Re-enqueuing the same dedupeKey respects the paused reservation.
    enqueueJob(db, { dedupeKey: 'scan:lib1', kind: 'scan_library', priority: 1, libraryId: 'lib1' }, 400)
    expect(getJob(db, job1.id)?.state).toBe('paused')

    await runWorkerRecovery(db, config, { now: 100_000 })
    expect(getJob(db, job1.id)?.state).toBe('paused')
    expect(claimNextJob(db, 100_100, { workerId: 'w1', leaseMs: 5_000 })).toBeNull()
    db.close()
  })

  test('empty mountpoint root blocks scan even when SCAN_DELETE_FORCE=true', async () => {
    const { dir, config } = await makeTempConfig()
    config.scanDeleteForce = true
    const emptyDrive = path.join(config.mediaRoot, 'drives/e')
    await mkdir(emptyDrive, { recursive: true })

    const db = openDatabase(path.join(dir, 'mount.db'))
    createLibrary(db, { id: 'lib-e', name: 'Drive E', rootPath: 'drives/e', createdAt: 1 })
    const fId = upsertFolder(db, {
      id: 'fe',
      libraryId: 'lib-e',
      parentId: null,
      relativePath: '',
      name: 'Drive E',
      depth: 0,
      scanId: 's0',
    })
    insertAsset(db, {
      id: 'existing01',
      libraryId: 'lib-e',
      folderId: fId,
      relativePath: 'movie.mp4',
      filename: 'movie.mp4',
      kind: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 1024,
      mtimeMs: 1000,
      width: 640,
      height: 360,
      durationMs: 5000,
      takenAt: 1000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      container: 'mp4',
      indexedAt: 1000,
      scanId: 's0',
    })

    await expect(scanLibrary(db, config, 'lib-e')).rejects.toThrow(/drive_unavailable/)
    expect(countAssets(db, 'lib-e')).toBe(1)
    db.close()
  })

  test('VACUUM INTO backup passes integrity check and restores rows reliably', async () => {
    const { dir } = await makeTempConfig()
    const dbPath = path.join(dir, 'primary.db')
    const db = openDatabase(dbPath)
    createLibrary(db, { id: 'lib-b', name: 'BackupLib', rootPath: 'Backup', createdAt: 1 })
    const backupDir = path.join(dir, 'backups')

    const record = createDatabaseBackup(db, backupDir, { retentionCount: 2, now: 1_000 })
    expect(record.integrity).toBe('ok')
    expect(record.sizeBytes).toBeGreaterThan(0)
    db.close()

    const restoredPath = path.join(dir, 'restored.db')
    const verify = restoreDatabaseBackup(path.join(backupDir, record.filename), restoredPath)
    expect(verify.integrity).toBe('ok')

    const restoredDb = openDatabase(restoredPath)
    const libs = restoredDb.query<{ id: string }, []>('SELECT id FROM libraries').all()
    expect(libs.map((l) => l.id)).toEqual(['lib-b'])
    restoredDb.close()
  })
})
