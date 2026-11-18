import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import {
  createLibrary,
  insertAsset,
  openDatabase,
  touchAssets,
  upsertFolder,
} from '../packages/database/src/index'
import { probeImage } from '../packages/media/src/index'
import { scanLibrary } from '../apps/worker/src/scan'
import type { WorkerConfig } from '../apps/worker/src/config'

async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return
  let idx = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const current = idx
      idx += 1
      await fn(items[current]!)
    }
  })
  await Promise.all(workers)
}

async function listRecursive(root: string): Promise<string[]> {
  const dirs = [root]
  const files: string[] = []
  while (dirs.length > 0) {
    const dir = dirs.pop()!
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) dirs.push(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  return files
}

async function setupSyntheticDataset(root: string, fileCount: number, dirFanout = 20): Promise<void> {
  const sampleJpg = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 120, g: 140, b: 200 } },
  })
    .jpeg({ quality: 75 })
    .toBuffer()

  const perDir = Math.max(1, Math.ceil(fileCount / dirFanout))
  const batch: Array<{ abs: string }> = []
  for (let i = 0; i < fileCount; i += 1) {
    const bucket = `folder-${String(Math.floor(i / perDir)).padStart(4, '0')}`
    const dir = path.join(root, bucket)
    if (i % perDir === 0) await mkdir(dir, { recursive: true })
    batch.push({ abs: path.join(dir, `img-${String(i).padStart(6, '0')}.jpg`) })
  }
  await mapPool(batch, 32, async ({ abs }) => {
    await writeFile(abs, sampleJpg)
  })
}

async function benchSqliteWrites(count: number, batchSize: number): Promise<number> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mv-bench-sql-'))
  const dbPath = path.join(dir, 'bench.db')
  const db = openDatabase(dbPath)
  createLibrary(db, { id: 'lib1', name: 'Bench', rootPath: 'Bench', createdAt: 1 })
  const fId = upsertFolder(db, {
    id: 'f1',
    libraryId: 'lib1',
    parentId: null,
    relativePath: '',
    name: 'Bench',
    depth: 0,
    scanId: 's0',
  })

  const started = performance.now()
  if (batchSize <= 1) {
    for (let i = 0; i < count; i += 1) {
      insertAsset(db, {
        id: `a-${i}`,
        libraryId: 'lib1',
        folderId: fId,
        relativePath: `f/img-${i}.jpg`,
        filename: `img-${i}.jpg`,
        kind: 'image',
        mimeType: 'image/jpeg',
        sizeBytes: 512,
        mtimeMs: 1_000,
        width: 16,
        height: 16,
        durationMs: null,
        takenAt: 1_000,
        videoCodec: null,
        audioCodec: null,
        container: 'jpg',
        indexedAt: 1_000,
        scanId: 's0',
      })
    }
  } else {
    for (let start = 0; start < count; start += batchSize) {
      const end = Math.min(count, start + batchSize)
      db.transaction(() => {
        for (let i = start; i < end; i += 1) {
          insertAsset(db, {
            id: `a-${i}`,
            libraryId: 'lib1',
            folderId: fId,
            relativePath: `f/img-${i}.jpg`,
            filename: `img-${i}.jpg`,
            kind: 'image',
            mimeType: 'image/jpeg',
            sizeBytes: 512,
            mtimeMs: 1_000,
            width: 16,
            height: 16,
            durationMs: null,
            takenAt: 1_000,
            videoCodec: null,
            audioCodec: null,
            container: 'jpg',
            indexedAt: 1_000,
            scanId: 's0',
          })
        }
      }).immediate()
    }
  }
  const elapsed = performance.now() - started

  const touchStart = performance.now()
  const ids = Array.from({ length: count }, (_, i) => `a-${i}`)
  for (let start = 0; start < ids.length; start += Math.max(250, batchSize)) {
    touchAssets(db, ids.slice(start, start + Math.max(250, batchSize)), 's1')
  }
  const touchMs = performance.now() - touchStart
  db.close()
  await rm(dir, { recursive: true, force: true })
  return batchSize <= 1 ? Math.round(elapsed) : Math.round(elapsed + touchMs * 0)
}

async function runSuite(): Promise<void> {
  const args = process.argv.slice(2)
  const fileCountArg = args.find((a) => a.startsWith('--count='))?.split('=')[1]
  const count = fileCountArg ? Number(fileCountArg) : 1000
  const baseParent = args.find((a) => a.startsWith('--dir='))?.split('=')[1] ?? os.tmpdir()
  const dir = await mkdtemp(path.join(baseParent, 'mv-scan-bench-'))
  const mediaRoot = path.join(dir, 'media')
  const libRoot = path.join(mediaRoot, 'Lib')

  try {
    await setupSyntheticDataset(libRoot, count, Math.min(100, Math.max(10, Math.floor(count / 25))))
    const tEnum0 = performance.now()
    const files = await listRecursive(libRoot)
    const enumMs = Math.round(performance.now() - tEnum0)

    const statMatrix: Record<number, number> = {}
    const probeMatrix: Record<number, number> = {}
    for (const concurrency of [1, 4, 8, 16, 32]) {
      const tStat0 = performance.now()
      await mapPool(files, concurrency, async (f) => {
        await stat(f)
      })
      statMatrix[concurrency] = Math.round(performance.now() - tStat0)

      const subset = files.slice(0, Math.min(files.length, 1000))
      const tProbe0 = performance.now()
      await mapPool(subset, concurrency, async (f) => {
        await probeImage(f, 1_000)
      })
      probeMatrix[concurrency] = Math.round(performance.now() - tProbe0)
    }

    const dbUnbatched1kMs = await benchSqliteWrites(Math.min(count, 1000), 1)
    const dbBatched250Ms = await benchSqliteWrites(count, 250)

    const dbPath = path.join(dir, 'scan.db')
    const db = openDatabase(dbPath)
    createLibrary(db, { id: 'lib1', name: 'Lib', rootPath: 'Lib', createdAt: 1 })
    const config: WorkerConfig = {
      dataDir: dir,
      cacheDir: path.join(dir, 'cache'),
      mediaRoot,
      hwaccel: null,
      pollMs: 100,
      once: true,
      gpuResource: 'gpu:0',
      workerId: 'bench-w',
      scanDeleteGuardRatio: 0.2,
      scanDeleteForce: false,
    }

    const tInitial0 = performance.now()
    const initSummary = await scanLibrary(db, config, 'lib1')
    const initialScanMs = Math.round(performance.now() - tInitial0)

    const tInc0 = performance.now()
    const incSummary = await scanLibrary(db, config, 'lib1')
    const incrementalScanMs = Math.round(performance.now() - tInc0)

    const rssMb = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10
    db.close()

    console.log(
      JSON.stringify(
        {
          count: files.length,
          dir: baseParent,
          enumMs,
          statMatrix,
          probeMatrix1kSubset: probeMatrix,
          dbUnbatched1kMs,
          dbBatched250Ms,
          initialScanMs,
          incrementalScanMs,
          initialPerFileMs: Number((initialScanMs / files.length).toFixed(2)),
          incrementalPerFileMs: Number((incrementalScanMs / files.length).toFixed(2)),
          rssMb,
          initSummary,
          incSummary,
        },
        null,
        2,
      ),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await runSuite()
