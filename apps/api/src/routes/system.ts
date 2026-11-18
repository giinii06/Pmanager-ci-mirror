import { readdir, realpath, stat } from 'node:fs/promises'
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

function isTempPathName(name: string): boolean {
  return (
    name.startsWith('.mv-extract-') ||
    name.includes('.tmp') ||
    isTempDownloadFile(name)
  )
}

interface WalkTally {
  totalBytes: number
  videoBytes: number
  imageBytes: number
  tempBytes: number
}

async function walkTreeSizes(
  root: string,
  seenDirs: Set<string>,
  classifyMedia: boolean,
  tally: WalkTally,
): Promise<void> {
  let canonical: string
  try {
    canonical = await realpath(root)
  } catch {
    return
  }
  if (seenDirs.has(canonical)) return
  seenDirs.add(canonical)

  let entries
  try {
    entries = await readdir(canonical, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const abs = path.join(canonical, entry.name)
    if (entry.isDirectory()) {
      if (isTempPathName(entry.name)) {
        const sub: WalkTally = { totalBytes: 0, videoBytes: 0, imageBytes: 0, tempBytes: 0 }
        await walkTreeSizes(abs, seenDirs, false, sub)
        tally.tempBytes += sub.totalBytes
        tally.totalBytes += sub.totalBytes
      } else {
        await walkTreeSizes(abs, seenDirs, classifyMedia, tally)
      }
      continue
    }
    if (!entry.isFile()) continue
    let size = 0
    try {
      size = (await stat(abs)).size
    } catch {
      continue
    }
    tally.totalBytes += size
    if (isTempPathName(entry.name)) {
      tally.tempBytes += size
      continue
    }
    if (classifyMedia) {
      const kind = classifyFile(entry.name)?.kind
      if (kind === 'video') tally.videoBytes += size
      else if (kind === 'image') tally.imageBytes += size
    }
  }
}

async function computeStorageStats(ctx: AppContext): Promise<StorageStatsDTO> {
  const stats = getStats(ctx.db)
  const seenMediaDirs = new Set<string>()
  const libTally: WalkTally = { totalBytes: 0, videoBytes: 0, imageBytes: 0, tempBytes: 0 }

  for (const lib of listLibraries(ctx.db)) {
    const abs = resolveInside(ctx.config.mediaRoot, lib.rootPath)
    if (abs) await walkTreeSizes(abs, seenMediaDirs, true, libTally)
  }

  const thumbTally: WalkTally = { totalBytes: 0, videoBytes: 0, imageBytes: 0, tempBytes: 0 }
  const seenThumbDirs = new Set<string>()
  for (const sub of ['thumbs', 'previews']) {
    await walkTreeSizes(path.join(ctx.config.cacheDir, sub), seenThumbDirs, false, thumbTally)
  }

  const cacheTally: WalkTally = { totalBytes: 0, videoBytes: 0, imageBytes: 0, tempBytes: 0 }
  const seenCacheDirs = new Set<string>([...seenThumbDirs])
  await walkTreeSizes(ctx.config.cacheDir, seenCacheDirs, false, cacheTally)
  await walkTreeSizes(ctx.config.asr.resultDir, seenCacheDirs, false, cacheTally)
  await walkTreeSizes(ctx.config.translation.resultDir, seenCacheDirs, false, cacheTally)

  const tempBytes = libTally.tempBytes + thumbTally.tempBytes + cacheTally.tempBytes
  const thumbnailBytes = Math.max(0, thumbTally.totalBytes - thumbTally.tempBytes)
  const cacheBytes = Math.max(0, cacheTally.totalBytes - cacheTally.tempBytes)

  return {
    computedAt: new Date().toISOString(),
    totalLibraryBytes: libTally.totalBytes,
    videoBytes: libTally.videoBytes,
    imageBytes: libTally.imageBytes,
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
