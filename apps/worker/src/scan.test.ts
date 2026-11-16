import { afterAll, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import {
  createLibrary,
  insertAsset,
  openDatabase,
  upsertFolder,
  type Db,
  type NewAsset,
} from '@mediavault/database'
import type { WorkerConfig } from './config'
import { scanLibrary } from './scan'

const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

interface ScanHarness {
  root: string
  db: Db
  folderId: string
  config: WorkerConfig
}

async function harness(): Promise<ScanHarness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mediavault-scan-'))
  dirs.push(dir)
  const mediaRoot = path.join(dir, 'media')
  const root = path.join(mediaRoot, 'Videos')
  await mkdir(root, { recursive: true })

  const db = openDatabase(':memory:')
  createLibrary(db, { id: 'lib1', name: 'Videos', rootPath: 'Videos', createdAt: 1 })
  const folderId = upsertFolder(db, {
    id: 'folder1',
    libraryId: 'lib1',
    parentId: null,
    relativePath: 'Videos',
    name: 'Videos',
    depth: 0,
    scanId: 'seed',
  })

  return {
    root,
    db,
    folderId,
    config: {
      dataDir: dir,
      cacheDir: path.join(dir, 'cache'),
      mediaRoot,
      hwaccel: null,
      pollMs: 0,
      once: true,
      gpuResource: 'gpu:0',
      workerId: 'test',
      scanDeleteGuardRatio: 0.2,
      scanDeleteForce: false,
    },
  }
}

function imageAsset(
  id: string,
  folderId: string,
  filename: string,
  size: number,
  mtimeMs: number,
): NewAsset {
  return {
    id,
    libraryId: 'lib1',
    folderId,
    relativePath: filename,
    filename,
    kind: 'image',
    mimeType: filename.endsWith('.png') ? 'image/png' : 'image/jpeg',
    sizeBytes: size,
    mtimeMs,
    width: 4,
    height: 4,
    durationMs: null,
    takenAt: mtimeMs,
    videoCodec: null,
    audioCodec: null,
    container: null,
    indexedAt: 1,
    scanId: 'seed',
  }
}

async function seedUnchanged(h: ScanHarness, count: number, prefix = 'file'): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const name = `${prefix}-${index}.jpg`
    const file = path.join(h.root, name)
    await writeFile(file, '')
    const info = await stat(file)
    insertAsset(
      h.db,
      imageAsset(
        `${prefix}-${index}`,
        h.folderId,
        name,
        info.size,
        Math.round(info.mtimeMs),
      ),
    )
  }
}

function seedMissing(h: ScanHarness, count: number, prefix = 'gone'): void {
  for (let index = 0; index < count; index += 1) {
    insertAsset(
      h.db,
      imageAsset(`${prefix}-${index}`, h.folderId, `${prefix}-${index}.jpg`, 0, 1),
    )
  }
}

function deletedCount(h: ScanHarness): number {
  return (
    h.db
      .query<{ n: number }, []>(
        'SELECT COUNT(*) AS n FROM assets WHERE deleted_at IS NOT NULL',
      )
      .get()?.n ?? 0
  )
}

describe('scan writes', () => {
  test('every unchanged file is touched in one pass', async () => {
    const h = await harness()
    const names = Array.from({ length: 1_200 }, (_, index) => `img-${index}.jpg`)
    const stats: Array<{ name: string; size: number; mtimeMs: number }> = []
    for (const name of names) {
      const file = path.join(h.root, name)
      await writeFile(file, '')
      const info = await stat(file)
      stats.push({ name, size: info.size, mtimeMs: Math.round(info.mtimeMs) })
    }
    h.db.transaction(() => {
      for (const [index, info] of stats.entries()) {
        insertAsset(h.db, imageAsset(`asset-${index}`, h.folderId, info.name, info.size, info.mtimeMs))
      }
    })()

    const summary = await scanLibrary(h.db, h.config, 'lib1')

    expect(summary.files).toBe(1_200)
    expect(summary.updated).toBe(0)
    expect(summary.removed).toBe(0)
    const untouched = h.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM assets WHERE last_seen_scan = 'seed'",
      )
      .get()
    expect(untouched?.n).toBe(0)
    h.db.close()
  })

  test('a failed walk leaves every asset in place', async () => {
    const h = await harness()
    const keep = path.join(h.root, 'keep.jpg')
    const locked = path.join(h.root, 'locked')
    await writeFile(keep, '')
    await mkdir(locked)
    await writeFile(path.join(locked, 'inside.jpg'), '')
    const keepInfo = await stat(keep)
    const insideInfo = await stat(path.join(locked, 'inside.jpg'))
    insertAsset(
      h.db,
      imageAsset('keep', h.folderId, 'keep.jpg', keepInfo.size, Math.round(keepInfo.mtimeMs)),
    )
    insertAsset(
      h.db,
      imageAsset(
        'inside',
        h.folderId,
        'locked/inside.jpg',
        insideInfo.size,
        Math.round(insideInfo.mtimeMs),
      ),
    )
    await chmod(locked, 0o000)

    try {
      await expect(scanLibrary(h.db, h.config, 'lib1')).rejects.toThrow()
    } finally {
      await chmod(locked, 0o755)
    }

    const rows = h.db
      .query<{ deletedAt: number | null; lastSeenScan: string | null }, []>(
        'SELECT deleted_at AS deletedAt, last_seen_scan AS lastSeenScan FROM assets',
      )
      .all()
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.deletedAt).toBeNull()
      expect(row.lastSeenScan).toBe('seed')
    }
    h.db.close()
  })

  test('every seen file is marked before the missing ones are deleted', async () => {
    const h = await harness()
    for (let index = 0; index < 10; index += 1) {
      const name = `unchanged-${index}.jpg`
      const file = path.join(h.root, name)
      await writeFile(file, '')
      const info = await stat(file)
      insertAsset(
        h.db,
        imageAsset(
          `unchanged-${index}`,
          h.folderId,
          name,
          info.size,
          Math.round(info.mtimeMs),
        ),
      )
    }
    for (let index = 0; index < 10; index += 1) {
      const name = `changed-${index}.png`
      const file = path.join(h.root, name)
      await sharp({
        create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
      })
        .png()
        .toFile(file)
      const info = await stat(file)
      insertAsset(
        h.db,
        imageAsset(
          `changed-${index}`,
          h.folderId,
          name,
          info.size + 1,
          Math.round(info.mtimeMs) - 1,
        ),
      )
    }

    const summary = await scanLibrary(h.db, h.config, 'lib1')

    expect(summary.files).toBe(20)
    expect(summary.updated).toBe(10)
    expect(summary.removed).toBe(0)
    const stale = h.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM assets WHERE deleted_at IS NOT NULL OR last_seen_scan = 'seed'",
      )
      .get()
    expect(stale?.n).toBe(0)
    h.db.close()
  })
})

describe('delete guard', () => {
  test('an empty readable root aborts the scan', async () => {
    const h = await harness()
    seedMissing(h, 100)

    await expect(scanLibrary(h.db, h.config, 'lib1')).rejects.toThrow(
      'refusing to soft-delete 100 of 100 assets',
    )

    expect(deletedCount(h)).toBe(0)
    h.db.close()
  })

  test('a small deletion is allowed', async () => {
    const h = await harness()
    await seedUnchanged(h, 90)
    seedMissing(h, 10)

    const summary = await scanLibrary(h.db, h.config, 'lib1')

    expect(summary.removed).toBe(10)
    expect(deletedCount(h)).toBe(10)
    h.db.close()
  })

  test('the guard ratio is configurable', async () => {
    const h = await harness()
    await seedUnchanged(h, 120)
    seedMissing(h, 80)

    await expect(scanLibrary(h.db, h.config, 'lib1')).rejects.toThrow(
      'refusing to soft-delete 80 of 200 assets',
    )

    h.config.scanDeleteGuardRatio = 0.5
    const summary = await scanLibrary(h.db, h.config, 'lib1')

    expect(summary.removed).toBe(80)
    h.db.close()
  })

  test('the force flag allows an intentional deletion', async () => {
    const h = await harness()
    h.config.scanDeleteForce = true
    seedMissing(h, 100)

    const summary = await scanLibrary(h.db, h.config, 'lib1')

    expect(summary.removed).toBe(100)
    h.db.close()
  })
})
