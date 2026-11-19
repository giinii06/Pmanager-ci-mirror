import { afterAll, describe, expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import {
  claimNextJob,
  completeJob,
  createLibrary,
  enqueueArchiveJobIfNeeded,
  enqueueJob,
  getActivityStats,
  getArchiveJob,
  listArchiveJobs,
  listAssets,
  openDatabase,
  updateArchiveJob,
  type Db,
} from '@mediavault/database'
import { PRIORITY } from '@mediavault/shared'
import type { WorkerConfig } from './config'
import { executeJob } from './handlers'
import { scanLibrary } from './scan'

const dirs: string[] = []
const dbs: Db[] = []

afterAll(async () => {
  for (const db of dbs) db.close()
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (const b of buf) {
    c ^= b
    for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0)
  }
  return (c ^ 0xffffffff) >>> 0
}

function buildRar4(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const chunks: Uint8Array[] = [Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])]
  const mhd = new Uint8Array(13)
  mhd[2] = 0x73
  mhd[5] = 13
  const mcrc = crc32(mhd.subarray(2)) & 0xffff
  mhd[0] = mcrc & 0xff
  mhd[1] = (mcrc >> 8) & 0xff
  chunks.push(mhd)

  for (const f of files) {
    const nameBytes = Buffer.from(f.name, 'utf8')
    const hdr = new Uint8Array(32 + nameBytes.length)
    const dv = new DataView(hdr.buffer)
    hdr[2] = 0x74
    dv.setUint16(3, 0x8000, true)
    dv.setUint16(5, hdr.length, true)
    dv.setUint32(7, f.data.length, true)
    dv.setUint32(11, f.data.length, true)
    hdr[15] = 0x03
    dv.setUint32(16, crc32(f.data), true)
    hdr[24] = 29
    hdr[25] = 0x30
    dv.setUint16(26, nameBytes.length, true)
    hdr.set(nameBytes, 32)
    dv.setUint16(0, crc32(hdr.subarray(2)) & 0xffff, true)
    chunks.push(hdr, f.data)
  }
  chunks.push(Uint8Array.from([0xc4, 0x3d, 0x7b, 0x00, 0x40, 0x07, 0x00]))
  return Buffer.concat(chunks)
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

describe('worker archive pipeline end-to-end', () => {
  test('scan enqueues RAR, worker extracts & converts flatly, rescans, and records 1 folder contribution', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mv-worker-rar-'))
    dirs.push(dir)
    const mediaRoot = path.join(dir, 'media')
    const setDir = path.join(mediaRoot, 'ModelA', 'Set1')
    await mkdir(setDir, { recursive: true })

    const img1 = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 200, g: 100, b: 50 } },
    })
      .png()
      .toBuffer()
    const img2 = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 50, g: 100, b: 200 } },
    })
      .png()
      .toBuffer()

    const rarPath = path.join(setDir, 'Set1.rar')
    await writeFile(
      rarPath,
      buildRar4([
        { name: '01.png', data: img1 },
        { name: '02.png', data: img2 },
      ]),
    )

    const db = openDatabase(':memory:')
    dbs.push(db)
    createLibrary(db, { id: 'lib1', name: 'ModelA', rootPath: 'ModelA', createdAt: 1 })
    const config: WorkerConfig = {
      dataDir: dir,
      cacheDir: path.join(dir, 'cache'),
      mediaRoot,
      hwaccel: null,
      pollMs: 50,
      once: true,
      gpuResource: 'gpu:0',
      workerId: 'w-test',
      scanDeleteGuardRatio: 0.2,
      scanDeleteForce: false,
      archiveStableMs: 20,
    }

    await scanLibrary(db, config, 'lib1')
    const job = claimNextJob(db, Date.now())
    expect(job?.kind).toBe('process_archive')

    await executeJob(db, config, job!)
    completeJob(db, job!.id, Date.now())

    expect(await exists(path.join(setDir, '01.jpg'))).toBe(true)
    expect(await exists(path.join(setDir, '02.jpg'))).toBe(true)
    expect(await exists(rarPath)).toBe(false)

    const archives = listArchiveJobs(db)
    expect(archives[0]).toMatchObject({
      state: 'completed',
      extractedFiles: 2,
      convertedImages: 2,
      convertedVideos: 0,
    })

    const assets = listAssets(db, {}, null, 20)
    expect(assets.total).toBe(2)

    const activity = getActivityStats(db)
    expect(activity.totalCount).toBe(1)
    expect(activity.folderContributions).toBe(1)

    await scanLibrary(db, config, 'lib1')
    expect(getActivityStats(db).totalCount).toBe(1)
  })

  test('retried job leaves an already completed archive row completed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mv-worker-retry-'))
    dirs.push(dir)
    const mediaRoot = path.join(dir, 'media')
    const setDir = path.join(mediaRoot, 'ModelA', 'Set1')
    await mkdir(setDir, { recursive: true })

    const db = openDatabase(':memory:')
    dbs.push(db)
    createLibrary(db, { id: 'lib1', name: 'ModelA', rootPath: 'ModelA', createdAt: 1 })
    const config: WorkerConfig = {
      dataDir: dir,
      cacheDir: path.join(dir, 'cache'),
      mediaRoot,
      hwaccel: null,
      pollMs: 50,
      once: true,
      gpuResource: 'gpu:0',
      workerId: 'w-test',
      scanDeleteGuardRatio: 0.2,
      scanDeleteForce: false,
      archiveStableMs: 20,
    }

    const { record } = enqueueArchiveJobIfNeeded(
      db,
      {
        id: 'aj-done',
        libraryId: 'lib1',
        archivePath: 'ModelA/Set1/Set1.part1.rar',
        signature: 'Set1.part1.rar:4096:1',
      },
      1,
    )
    updateArchiveJob(
      db,
      record.id,
      { state: 'completed', extractedFiles: 67, errorMessage: null },
      2,
    )

    const volumes = [
      path.join(setDir, 'Set1.part1.rar'),
      path.join(setDir, 'Set1.part2.rar'),
    ]
    enqueueJob(
      db,
      {
        dedupeKey: `archive:${record.id}`,
        kind: 'process_archive',
        priority: PRIORITY.visible,
        libraryId: 'lib1',
        payload: {
          archiveJobId: record.id,
          libraryId: 'lib1',
          primaryPath: volumes[0],
          volumes,
        },
      },
      Date.now(),
    )

    const job = claimNextJob(db, Date.now())
    expect(job?.kind).toBe('process_archive')

    await executeJob(db, config, job!)

    expect(getArchiveJob(db, record.id)).toMatchObject({
      state: 'completed',
      extractedFiles: 67,
      errorMessage: null,
    })
  })
})
