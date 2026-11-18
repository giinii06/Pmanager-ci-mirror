import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import {
  activeJobs,
  getActivityStats,
  getStats,
  jobCounts,
  listArchiveJobs,
  listLibraries,
  recentFailures,
  workQueue,
} from '@mediavault/database'
import { isTempDownloadFile, resolveInside } from '@mediavault/media'
import { classifyFile, type StorageStatsDTO } from '@mediavault/shared'
import type { AppContext } from '../context'
import { toArchiveJobDTO, toJobDTO, toWorkQueueDTO } from '../dto'

const STORAGE_CACHE_TTL_MS = 30_000
const WALK_CONCURRENCY = 24

function isTempPathName(name: string): boolean {
  return (
    name.startsWith('.mv-extract-') ||
    name.includes('.tmp') ||
    isTempDownloadFile(name)
  )
}

interface WalkTally {
  totalBytes: number
  otherBytes: number
  tempBytes: number
}

async function runBounded<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return
  let next = 0
  const workers = Array.from({ length: Math.min(WALK_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const idx = next
      next += 1
      await worker(items[idx]!)
    }
  })
  await Promise.all(workers)
}

async function walkTreeSizes(
  root: string,
  seenDirs: Set<string>,
  skipIndexedMediaStat: boolean,
  tally: WalkTally,
): Promise<void> {
  const queue: Array<{ dir: string; forceTemp: boolean }> = [
    { dir: path.resolve(root), forceTemp: false },
  ]

  while (queue.length > 0) {
    const batch = queue.splice(0, WALK_CONCURRENCY)
    await Promise.all(
      batch.map(async ({ dir, forceTemp }) => {
        if (seenDirs.has(dir)) return
        seenDirs.add(dir)

        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          return
        }

        const filesToStat: Array<{ abs: string; temp: boolean }> = []
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue
          const abs = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            queue.push({ dir: abs, forceTemp: forceTemp || isTempPathName(entry.name) })
            continue
          }
          if (!entry.isFile()) continue
          const temp = forceTemp || isTempPathName(entry.name)
          if (!temp && skipIndexedMediaStat && classifyFile(entry.name)) continue
          filesToStat.push({ abs, temp })
        }

        await runBounded(filesToStat, async ({ abs, temp }) => {
          try {
            const size = (await stat(abs)).size
            tally.totalBytes += size
            if (temp) tally.tempBytes += size
            else tally.otherBytes += size
          } catch {
            // File disappeared mid-walk.
          }
        })
      }),
    )
  }
}

async function computeStorageStats(ctx: AppContext): Promise<StorageStatsDTO> {
  const stats = getStats(ctx.db)
  const mediaRow = ctx.db
    .query<{ videoBytes: number; imageBytes: number }, []>(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'video' THEN size_bytes ELSE 0 END), 0) AS videoBytes,
              COALESCE(SUM(CASE WHEN kind = 'image' THEN size_bytes ELSE 0 END), 0) AS imageBytes
       FROM assets
       WHERE deleted_at IS NULL`,
    )
    .get()
  const videoBytes = mediaRow?.videoBytes ?? 0
  const imageBytes = mediaRow?.imageBytes ?? 0

  const seenMediaDirs = new Set<string>()
  const libTally: WalkTally = { totalBytes: 0, otherBytes: 0, tempBytes: 0 }

  for (const lib of listLibraries(ctx.db)) {
    const abs = resolveInside(ctx.config.mediaRoot, lib.rootPath)
    if (abs) await walkTreeSizes(abs, seenMediaDirs, true, libTally)
  }

  const thumbTally: WalkTally = { totalBytes: 0, otherBytes: 0, tempBytes: 0 }
  const seenThumbDirs = new Set<string>()
  for (const sub of ['thumbs', 'previews']) {
    await walkTreeSizes(path.join(ctx.config.cacheDir, sub), seenThumbDirs, false, thumbTally)
  }

  const cacheTally: WalkTally = { totalBytes: 0, otherBytes: 0, tempBytes: 0 }
  const seenCacheDirs = new Set<string>(seenThumbDirs)
  await walkTreeSizes(ctx.config.cacheDir, seenCacheDirs, false, cacheTally)
  await walkTreeSizes(ctx.config.asr.resultDir, seenCacheDirs, false, cacheTally)
  await walkTreeSizes(ctx.config.translation.resultDir, seenCacheDirs, false, cacheTally)

  const tempBytes = libTally.tempBytes + thumbTally.tempBytes + cacheTally.tempBytes
  const thumbnailBytes = thumbTally.otherBytes
  const cacheBytes = cacheTally.otherBytes
  const totalLibraryBytes = videoBytes + imageBytes + libTally.otherBytes + libTally.tempBytes

  return {
    computedAt: new Date().toISOString(),
    totalLibraryBytes,
    videoBytes,
    imageBytes,
    thumbnailBytes,
    cacheBytes,
    tempBytes,
    assetCount: stats.assets,
    videoCount: stats.videos,
    imageCount: stats.images,
  }
}

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  let cachedStorage: { expiresAt: number; data: StorageStatsDTO } | null = null

  app.get('/api/health', async (_request, reply) => {
    reply.send({ ok: true, version: '0.1.0' })
  })

  app.get('/api/stats', async (_request, reply) => {
    reply.send(getStats(ctx.db))
  })

  app.get('/api/stats/activity', async (_request, reply) => {
    reply.send(getActivityStats(ctx.db))
  })

  app.get('/api/stats/storage', async (request, reply) => {
    const query = request.query as { refresh?: string } | undefined
    const force = query?.refresh === '1' || query?.refresh === 'true'
    const now = Date.now()
    if (!force && cachedStorage && now < cachedStorage.expiresAt) {
      reply.send(cachedStorage.data)
      return
    }
    const data = await computeStorageStats(ctx)
    cachedStorage = { expiresAt: Date.now() + STORAGE_CACHE_TTL_MS, data }
    reply.send(data)
  })

  app.get('/api/archives', async (_request, reply) => {
    reply.send({ archives: listArchiveJobs(ctx.db).map(toArchiveJobDTO) })
  })

  app.get('/api/jobs', async (_request, reply) => {
    reply.send({
      counts: jobCounts(ctx.db),
      active: activeJobs(ctx.db).map(toJobDTO),
      recentFailures: recentFailures(ctx.db).map(toJobDTO),
    })
  })

  app.get('/api/queue', async (_request, reply) => {
    reply.send(toWorkQueueDTO(workQueue(ctx.db, Date.now(), ctx.config.gpu.resourceId)))
  })
}
