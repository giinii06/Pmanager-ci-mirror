import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  jobCounts,
  pruneDiagnosticsRuns,
  recordDiagnosticsRun,
} from '@mediavault/database'
import {
  APP_VERSION,
  CACHE_TYPES,
  newId,
  type CapabilitiesDTO,
  type DiagnosticsReportDTO,
  type SystemMetricsDTO,
} from '@mediavault/shared'
import { uptimeSeconds } from '../boot'
import { cleanCache, scanCache, toCleanupPreview } from '../cache-inventory'
import type { AppContext } from '../context'
import { buildDiagnosticsReport, renderDiagnosticsMarkdown } from '../diagnostics'
import { defaultMetrics } from '../observability'
import { parseInput } from '../validate'

const diagnosticsQuery = z.object({
  format: z.enum(['json', 'md']).optional(),
  download: z.enum(['0', '1']).optional(),
  refresh: z.enum(['0', '1']).optional(),
})

const cleanBody = z.object({
  generation: z.string().min(1),
  types: z.array(z.enum(CACHE_TYPES)).min(1).optional(),
})

export function registerDiagnosticsRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Compute on the server after listen and periodically. Normal reads never traverse
  // the filesystem; they return the latest completed (possibly aging) snapshot.
  const SNAPSHOT_INTERVAL_MS = 60_000
  let cached: DiagnosticsReportDTO | null = null
  let computing: Promise<DiagnosticsReportDTO> | null = null

  const compute = (): Promise<DiagnosticsReportDTO> => {
    if (computing) return computing
    computing = buildDiagnosticsReport(ctx)
      .then((report) => {
        cached = report
        return report
      })
      .finally(() => {
        computing = null
      })
    return computing
  }

  const logFailure = (error: unknown) =>
    app.log.warn({ err: error }, 'diagnostics snapshot refresh failed')

  let interval: ReturnType<typeof setInterval> | null = null
  app.addHook('onListen', () => {
    void compute().catch(logFailure)
    interval = setInterval(() => {
      void compute().catch(logFailure)
    }, SNAPSHOT_INTERVAL_MS)
    interval.unref?.()
  })
  app.addHook('onClose', async () => {
    if (interval) clearInterval(interval)
  })

  const reportFor = async (refresh: boolean): Promise<DiagnosticsReportDTO> => {
    if (refresh && cached) void compute().catch(logFailure)
    // First boot is the only unavoidable cold path (also used by app.inject tests).
    return cached ?? await compute()
  }

  app.get('/api/system/capabilities', async (_request, reply) => {
    const schema = ctx.db.query<{ user_version: number }, []>('PRAGMA user_version').get()
    const payload: CapabilitiesDTO = {
      fileMutation: ctx.config.fileMutationEnabled,
      hlsGenerations: ctx.config.hlsGenerationsEnabled,
      bulkOperations: false,
      notifications: ctx.config.notificationsEnabled === true,
      searchFts: ctx.config.search.ftsEnabled,
      smartAlbums: false,
      version: APP_VERSION,
      schemaVersion: schema?.user_version ?? 0,
    }
    reply.send(payload)
  })

  app.get('/api/system/diagnostics', async (request, reply) => {
    const query = parseInput(diagnosticsQuery, request.query, reply)
    if (!query) return
    const format = query.format ?? 'json'
    const report = await reportFor(query.refresh === '1')
    const body = format === 'md' ? renderDiagnosticsMarkdown(report) : JSON.stringify(report, null, 2)

    if (query.download === '1') {
      recordDiagnosticsRun(ctx.db, {
        id: newId(16),
        userId: request.user?.id ?? null,
        format,
        sizeBytes: Buffer.byteLength(body),
        now: Date.now(),
      })
      pruneDiagnosticsRuns(ctx.db, 50)
    }

    reply.header(
      'content-type',
      format === 'md' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8',
    )
    if (query.download === '1') {
      const stamp = report.generatedAt.replaceAll(':', '-').replace(/\.\d+Z$/, 'Z')
      reply.header(
        'content-disposition',
        `attachment; filename="mediavault-diagnostics-${stamp}.${format}"`,
      )
    }
    reply.send(body)
  })

  app.get('/api/system/metrics', async (_request, reply) => {
    const metrics = ctx.metrics ?? defaultMetrics
    const now = Date.now()
    const pages = ctx.db.query<{ page_count: number }, []>('PRAGMA page_count').get()
    const freelist = ctx.db.query<{ freelist_count: number }, []>('PRAGMA freelist_count').get()
    const memory = process.memoryUsage()
    const dbPath = path.join(ctx.config.dataDir, 'mediavault.db')
    const dbBytes = await Bun.file(dbPath)
      .stat()
      .then((info) => info.size)
      .catch(() => 0)
    const walBytes = await Bun.file(`${dbPath}-wal`)
      .stat()
      .then((info) => info.size)
      .catch(() => 0)

    const payload: SystemMetricsDTO = {
      since: metrics.sinceIso(),
      generatedAt: new Date(now).toISOString(),
      requests: metrics.snapshot(),
      database: {
        walBytes,
        dbBytes,
        pageCount: pages?.page_count ?? 0,
        freelistCount: freelist?.freelist_count ?? 0,
      },
      queues: jobCounts(ctx.db),
      process: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        uptimeSeconds: uptimeSeconds(now),
      },
    }
    reply.send(payload)
  })

  app.get('/api/system/cache', async (_request, reply) => {
    const scan = await scanCache(ctx)
    reply.send(scan.inventory)
  })

  app.post('/api/system/cache/preview', async (_request, reply) => {
    const scan = await scanCache(ctx)
    reply.send(toCleanupPreview(scan))
  })

  app.post('/api/system/cache/clean', async (request, reply) => {
    const body = parseInput(cleanBody, request.body, reply)
    if (!body) return
    const outcome = await cleanCache(ctx, {
      generation: body.generation,
      types: body.types,
      userId: request.user?.id ?? null,
    })
    if (!outcome.applied) {
      reply.code(409).send({
        error: 'cache_preview_changed',
        message: 'The cache changed since the preview. Run the preview again.',
      })
      return
    }
    reply.send(outcome.result)
  })
}
