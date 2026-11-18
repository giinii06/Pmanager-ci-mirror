import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  activeJobs,
  cancelJob,
  createDatabaseBackup,
  getActivityStats,
  getJob,
  getLatestBackupLog,
  getLatestRecoveryLog,
  getSqliteRuntimeInfo,
  getStats,
  getVoteActivityStats,
  jobCounts,
  listActiveWorkerLeases,
  listArchiveJobs,
  listBackupLogs,
  listLibraries,
  pauseJob,
  recentFailures,
  resumeJob,
  workQueue,
  type BackupLogRecord,
} from '@mediavault/database'
import { isTempDownloadFile, resolveInside } from '@mediavault/media'
import {
  classifyFile,
  isBlockedSystemRelativePath,
  isMountBoundaryRoot,
  type BackupRecordDTO,
  type LibraryHealthDTO,
  type StorageStatsDTO,
  type SystemStatusDTO,
} from '@mediavault/shared'
import type { AppContext } from '../context'
import { toArchiveJobDTO, toJobDTO, toWorkQueueDTO } from '../dto'
import { parseInput } from '../validate'

const BOOT_AT_MS = Date.now()
const BOOT_AT_ISO = new Date(BOOT_AT_MS).toISOString()
const STORAGE_CACHE_TTL_MS = 30_000
const INTEGRITY_CACHE_TTL_MS = 60_000
const WALK_CONCURRENCY = 24
const jobIdParams = z.object({ id: z.coerce.number().int().positive() })

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
  skipRootSubMounts?: string | null,
): Promise<void> {
  const resolvedRoot = path.resolve(root)
  const queue: Array<{ dir: string; forceTemp: boolean }> = [
    { dir: resolvedRoot, forceTemp: false },
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
            if (isBlockedSystemRelativePath(entry.name)) continue
            if (
              skipRootSubMounts &&
              dir === skipRootSubMounts &&
              (entry.name === 'drives' || entry.name === 'extra')
            ) {
              continue
            }
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

  const seenMediaDirs = new Set<string>([
    path.resolve(ctx.config.cacheDir),
    path.resolve(ctx.config.dataDir),
    path.resolve(ctx.config.asr.resultDir),
    path.resolve(ctx.config.translation.resultDir),
  ])
  const libTally: WalkTally = { totalBytes: 0, otherBytes: 0, tempBytes: 0 }

  for (const lib of listLibraries(ctx.db)) {
    const abs = resolveInside(ctx.config.mediaRoot, lib.rootPath)
    if (abs) {
      await walkTreeSizes(
        abs,
        seenMediaDirs,
        true,
        libTally,
        lib.rootPath === '' ? path.resolve(ctx.config.mediaRoot) : null,
      )
    }
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
  const totalLibraryBytes = videoBytes + imageBytes + libTally.otherBytes

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

function toBackupRecordDTO(row: BackupLogRecord): BackupRecordDTO {
  return {
    id: row.id,
    filename: row.filename,
    sizeBytes: row.sizeBytes,
    integrity: row.integrity,
    createdAt: new Date(row.createdAt).toISOString(),
    error: row.error,
  }
}

async function checkLibraryHealth(ctx: AppContext): Promise<LibraryHealthDTO[]> {
  const libs = listLibraries(ctx.db)
  return Promise.all(
    libs.map(async (lib) => {
      const abs = resolveInside(ctx.config.mediaRoot, lib.rootPath)
      let accessible = false
      if (abs) {
        try {
          const info = await stat(abs)
          if (info.isDirectory()) {
            if (isMountBoundaryRoot(lib.rootPath) && lib.assetCount > 0) {
              const entries = await readdir(abs)
              accessible = entries.length > 0
            } else {
              accessible = true
            }
          }
        } catch {
          accessible = false
        }
      }

      const status: LibraryHealthDTO['status'] = !accessible
        ? 'unavailable'
        : lib.lastError?.startsWith('drive_unavailable')
          ? 'blocked'
          : lib.scanState === 'scanning'
            ? 'scanning'
            : 'available'

      return {
        id: lib.id,
        name: lib.name,
        rootPath: lib.rootPath,
        status,
        scanState: lib.scanState,
        lastError: lib.lastError,
        lastScanAt: lib.lastScanAt !== null ? new Date(lib.lastScanAt).toISOString() : null,
        assetCount: lib.assetCount,
        scannedFiles: lib.scannedFiles,
      }
    }),
  )
}

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  let cachedStorage: { expiresAt: number; data: StorageStatsDTO } | null = null
  let cachedIntegrity: { expiresAt: number; value: string } | null = null

  const liveHandler = async () => ({
    ok: true,
    pid: process.pid,
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - BOOT_AT_MS) / 1000)),
    timestamp: new Date().toISOString(),
  })

  const readyHandler = async (_request: unknown, reply: import('fastify').FastifyReply) => {
    try {
      ctx.db.query<{ ok: number }, []>('SELECT 1 AS ok').get()
      await stat(ctx.config.mediaRoot)
      await stat(ctx.config.cacheDir)
      const sqlite = getSqliteRuntimeInfo(ctx.db, { checkIntegrity: false })
      reply.send({
        ok: true,
        uptimeSeconds: Math.max(0, Math.floor((Date.now() - BOOT_AT_MS) / 1000)),
        dbIntegrity: cachedIntegrity ? cachedIntegrity.value : sqlite.integrity,
        sqliteVersion: sqlite.sqliteVersion,
        synchronousMode: sqlite.synchronousMode,
      })
    } catch (error) {
      reply.code(503).send({
        ok: false,
        error: error instanceof Error ? error.message : 'dependency check failed',
      })
    }
  }

  app.get('/api/health', async (_request, reply) => {
    reply.send({ ok: true, version: '0.1.0' })
  })
  app.get('/health/live', liveHandler)
  app.get('/api/health/live', liveHandler)
  app.get('/health/ready', readyHandler)
  app.get('/api/health/ready', readyHandler)

  app.get('/api/stats', async (_request, reply) => {
    reply.send(getStats(ctx.db))
  })

  app.get('/api/stats/activity', async (_request, reply) => {
    reply.send(getActivityStats(ctx.db))
  })

  app.get('/api/stats/votes-activity', async (_request, reply) => {
    reply.send(getVoteActivityStats(ctx.db))
  })

  app.get('/api/system/status', async (_request, reply) => {
    const now = Date.now()
    const checkIntegrity = !cachedIntegrity || now >= cachedIntegrity.expiresAt
    const sqlite = getSqliteRuntimeInfo(ctx.db, { checkIntegrity })
    const integrity = checkIntegrity ? sqlite.integrity : cachedIntegrity!.value
    if (checkIntegrity) {
      cachedIntegrity = { expiresAt: now + INTEGRITY_CACHE_TTL_MS, value: integrity }
    }
    const libraries = await checkLibraryHealth(ctx)
    const recovery = getLatestRecoveryLog(ctx.db)
    const latestBackup = getLatestBackupLog(ctx.db)
    const payload: SystemStatusDTO = {
      startedAt: BOOT_AT_ISO,
      uptimeSeconds: Math.max(0, Math.floor((now - BOOT_AT_MS) / 1000)),
      dbIntegrity: integrity,
      sqliteVersion: sqlite.sqliteVersion,
      synchronousMode: sqlite.synchronousMode,
      jobCounts: jobCounts(ctx.db),
      activeWorkers: listActiveWorkerLeases(ctx.db, now).map((w) => ({
        ...w,
        leaseExpiresAt: w.leaseExpiresAt !== null ? new Date(w.leaseExpiresAt).toISOString() : null,
      })),
      libraries,
      lastRecovery: recovery
        ? {
            workerId: recovery.workerId,
            recoveredJobs: recovery.recoveredJobs,
            cleanedTempFiles: recovery.cleanedTempFiles,
            requeuedThumbnails: recovery.requeuedThumbnails,
            dbIntegrity: recovery.dbIntegrity,
            createdAt: new Date(recovery.createdAt).toISOString(),
          }
        : null,
      lastBackup: latestBackup ? toBackupRecordDTO(latestBackup) : null,
    }
    reply.send(payload)
  })

  app.get('/api/backups', async (_request, reply) => {
    reply.send({ backups: listBackupLogs(ctx.db, 20).map(toBackupRecordDTO) })
  })

  app.post('/api/backups', async (_request, reply) => {
    const backup = createDatabaseBackup(ctx.db, path.join(ctx.config.dataDir, 'backups'), {
      retentionCount: 14,
    })
    reply.code(201).send({ backup: toBackupRecordDTO(backup) })
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

  const jobAction = async (
    request: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
    action: 'pause' | 'resume' | 'cancel',
  ) => {
    const params = parseInput(jobIdParams, request.params, reply)
    if (!params) return
    const existing = getJob(ctx.db, params.id)
    if (!existing) {
      reply.code(404).send({ error: 'not_found', message: 'Job not found.' })
      return
    }
    const now = Date.now()
    if (action === 'resume') {
      if (existing.state !== 'paused') {
        reply.code(409).send({ error: 'invalid_state', message: 'Only paused jobs can be resumed.' })
        return
      }
      const updated = resumeJob(ctx.db, params.id, now)
      reply.send({ job: toJobDTO(updated!) })
      return
    }
    if (existing.state === 'done' || existing.state === 'cancelled' || existing.state === 'failed') {
      reply.code(409).send({ error: 'invalid_state', message: `Job is already ${existing.state}.` })
      return
    }
    const updated =
      action === 'pause' ? pauseJob(ctx.db, params.id, now) : cancelJob(ctx.db, params.id, now)
    reply.send({ job: toJobDTO(updated!) })
  }

  app.post('/api/jobs/:id/pause', (req, reply) => jobAction(req, reply, 'pause'))
  app.post('/api/jobs/:id/resume', (req, reply) => jobAction(req, reply, 'resume'))
  app.post('/api/jobs/:id/cancel', (req, reply) => jobAction(req, reply, 'cancel'))

  app.get('/api/queue', async (_request, reply) => {
    reply.send(toWorkQueueDTO(workQueue(ctx.db, Date.now(), ctx.config.gpu.resourceId)))
  })
}
