import path from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  claimAsrJob,
  completeAsrJob,
  failAsrJob,
  getAsrJob,
  getAssetFileInfo,
  getLibrary,
  heartbeatAsrJob,
  recoverExpiredAsrJobs,
  updateAsrProgress,
} from '@mediavault/database'
import type { AppContext } from '../context'
import { toAsrJobDTO } from '../dto'
import { enqueueEmbedding } from '../embedding-trigger'
import { enqueueTranslation } from '../translation-trigger'
import { parseInput } from '../validate'

const WORKER_PREFIX = '/worker/asr'
const LEASE_MS = 120_000
const MAX_LEASE_MS = 600_000

const idParams = z.object({ id: z.string().min(1).max(64) })
const owner = z.string().min(1).max(128)

const claimBody = z.object({
  owner,
  leaseMs: z.number().int().min(10_000).max(MAX_LEASE_MS).optional(),
})

const heartbeatBody = z.object({ owner })

const progressBody = z.object({
  owner,
  state: z.enum(['transcribing', 'aligning', 'writing']),
  stage: z.enum(['extracting', 'chunking', 'transcribing', 'aligning', 'writing']),
  progress: z.number().min(0).max(99),
})

const completeBody = z.object({
  owner,
  transcriptId: z.string().min(6).max(64),
  resultDir: z.string().min(1).max(512),
  plainText: z.string().max(4_000_000),
  language: z.string().min(2).max(16),
  segments: z
    .array(
      z.object({
        startMs: z.number().int().min(0),
        endMs: z.number().int().min(0),
        text: z.string().min(1).max(2_000),
      }),
    )
    .max(20_000),
})

const failBody = z.object({ owner, message: z.string().min(1).max(2_000) })

function tokenMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function denied(): { error: string; message: string } {
  return { error: 'unauthorized', message: 'Worker token is missing or wrong.' }
}

/**
 * Worker routes are mounted outside /api/ on purpose. They never reach nginx
 * and they never accept a browser session cookie; the shared token is the only
 * credential.
 */
export function registerWorkerAsrRoutes(app: FastifyInstance, ctx: AppContext): void {
  if (!ctx.config.asr.enabled) return

  app.register(async (scope) => {
    scope.addHook('onRequest', async (request: FastifyRequest, reply) => {
      const header = request.headers['x-worker-token']
      const token = Array.isArray(header) ? header[0] : header
      if (!token || !tokenMatches(token, ctx.config.asr.workerToken)) {
        reply.code(401).send(denied())
        return reply
      }
    })

    scope.post(`${WORKER_PREFIX}/claim`, async (request, reply) => {
      const body = parseInput(claimBody, request.body ?? {}, reply)
      if (!body) return

      // The API is the only database writer, so it also owns lease recovery.
      // A worker that died mid-job leaves its lease behind; the next claim
      // turns it back into a queued job.
      const now = Date.now()
      recoverExpiredAsrJobs(ctx.db, now)

      const job = claimAsrJob(ctx.db, body.owner, body.leaseMs ?? LEASE_MS, now)
      if (!job) {
        reply.send({ job: null })
        return
      }

      const info = getAssetFileInfo(ctx.db, job.assetId)
      const library = info ? getLibrary(ctx.db, info.libraryId) : null
      if (!info || !library || info.deletedAt !== null) {
        failAsrJob(ctx.db, job.id, 'The asset disappeared before processing.', Date.now())
        reply.send({ job: null })
        return
      }

      reply.send({
        job: toAsrJobDTO(job),
        media: {
          path: path.posix.join(library.rootPath, info.relativePath),
          filename: info.filename,
          mimeType: info.mimeType,
          durationMs: info.durationMs,
        },
      })
    })

    scope.post(`${WORKER_PREFIX}/jobs/:id/heartbeat`, async (request, reply) => {
      const params = parseInput(idParams, request.params, reply)
      if (!params) return
      const body = parseInput(heartbeatBody, request.body ?? {}, reply)
      if (!body) return

      if (!heartbeatAsrJob(ctx.db, params.id, body.owner, Date.now())) {
        reply.code(409).send({ error: 'lease_lost', message: 'This worker no longer owns the job.' })
        return
      }
      reply.code(204).send()
    })

    scope.post(`${WORKER_PREFIX}/jobs/:id/progress`, async (request, reply) => {
      const params = parseInput(idParams, request.params, reply)
      if (!params) return
      const body = parseInput(progressBody, request.body ?? {}, reply)
      if (!body) return

      const kept = updateAsrProgress(
        ctx.db,
        params.id,
        body.owner,
        {
          state: body.state,
          stage: body.stage,
          progress: body.progress,
        },
        Date.now(),
      )
      if (!kept) {
        reply.code(409).send({ error: 'lease_lost', message: 'This worker no longer owns the job.' })
        return
      }
      reply.code(204).send()
    })

    scope.post(`${WORKER_PREFIX}/jobs/:id/complete`, async (request, reply) => {
      const params = parseInput(idParams, request.params, reply)
      if (!params) return
      const body = parseInput(completeBody, request.body ?? {}, reply)
      if (!body) return

      const job = getAsrJob(ctx.db, params.id)
      if (!job || job.leaseOwner !== body.owner) {
        reply.code(409).send({ error: 'lease_lost', message: 'This worker no longer owns the job.' })
        return
      }
      if (path.isAbsolute(body.resultDir) || body.resultDir.split(/[\\/]/).includes('..')) {
        reply.code(400).send({ error: 'invalid_request', message: 'resultDir must be relative.' })
        return
      }

      const segments = body.segments.map((segment, index) => ({
        seq: index,
        startMs: segment.startMs,
        endMs: Math.max(segment.startMs, segment.endMs),
        text: segment.text,
      }))
      const stored = completeAsrJob(
        ctx.db,
        {
          jobId: job.id,
          transcriptId: body.transcriptId,
          resultDir: body.resultDir,
          plainText: body.plainText,
          language: body.language,
          segments,
        },
        Date.now(),
      )
      if (!stored) {
        reply.code(404).send({ error: 'not_found', message: 'Job not found.' })
        return
      }

      // The transcript is already committed, so a translation that cannot be
      // queued must not turn a successful ASR run into a failed request.
      try {
        enqueueTranslation(ctx, stored, Date.now())
      } catch (error) {
        request.log.error({ err: error, transcriptId: stored.id }, 'translation enqueue failed')
      }

      try {
        enqueueEmbedding(ctx, stored.assetId, stored.fileVersion, Date.now())
      } catch (error) {
        request.log.error({ err: error, assetId: stored.assetId }, 'embedding enqueue failed')
      }

      reply.send({ transcriptId: stored.id })
    })

    scope.post(`${WORKER_PREFIX}/jobs/:id/fail`, async (request, reply) => {
      const params = parseInput(idParams, request.params, reply)
      if (!params) return
      const body = parseInput(failBody, request.body ?? {}, reply)
      if (!body) return

      const job = getAsrJob(ctx.db, params.id)
      if (!job || job.leaseOwner !== body.owner) {
        reply.code(409).send({ error: 'lease_lost', message: 'This worker no longer owns the job.' })
        return
      }

      const state = failAsrJob(ctx.db, job.id, body.message, Date.now())
      reply.send({ state })
    })
  })
}
