import path from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  claimTranslationJob,
  completeTranslationJob,
  failTranslationJob,
  getTranscriptById,
  getTranslationJob,
  heartbeatTranslationJob,
  recoverExpiredTranslationJobs,
  updateTranslationProgress,
} from '@mediavault/database'
import type { AppContext } from '../context'
import { toTranslationJobDTO } from '../dto'
import { parseInput } from '../validate'

const WORKER_PREFIX = '/worker/translation'
const LEASE_MS = 120_000
const MAX_LEASE_MS = 600_000

/** The schema accepts 20,000 cues; the global 1 MB limit is too small for them. */
const COMPLETE_BODY_LIMIT = 16 * 1024 * 1024

const idParams = z.object({ id: z.string().min(1).max(64) })
const owner = z.string().min(1).max(128)

const claimBody = z.object({
  owner,
  leaseMs: z.number().int().min(10_000).max(MAX_LEASE_MS).optional(),
})

const heartbeatBody = z.object({ owner })

const progressBody = z.object({
  owner,
  state: z.enum(['translating', 'writing']),
  stage: z.enum(['starting', 'translating', 'writing']),
  progress: z.number().min(0).max(99),
})

const completeBody = z.object({
  owner,
  translationId: z.string().min(6).max(64),
  resultDir: z.string().min(1).max(512),
  plainText: z.string().max(4_000_000),
  segments: z
    .array(
      z.object({
        seq: z.number().int().min(0),
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

function leaseLost(): { error: string; message: string } {
  return { error: 'lease_lost', message: 'This worker no longer owns the job.' }
}

/**
 * Translation worker routes live outside /api/ like the ASR ones: the shared
 * token is the only credential, and nginx never exposes the prefix.
 */
export function registerWorkerTranslationRoutes(app: FastifyInstance, ctx: AppContext): void {
  if (!ctx.config.translation.enabled) return

  app.register(async (scope) => {
    scope.addHook('onRequest', async (request: FastifyRequest, reply) => {
      const header = request.headers['x-worker-token']
      const token = Array.isArray(header) ? header[0] : header
      if (!token || !tokenMatches(token, ctx.config.translation.workerToken)) {
        reply.code(401).send(denied())
        return reply
      }
    })

    scope.post(`${WORKER_PREFIX}/claim`, async (request, reply) => {
      const body = parseInput(claimBody, request.body ?? {}, reply)
      if (!body) return

      const now = Date.now()
      recoverExpiredTranslationJobs(ctx.db, now)

      const job = claimTranslationJob(ctx.db, body.owner, body.leaseMs ?? LEASE_MS, now)
      if (!job) {
        reply.send({ job: null })
        return
      }

      const source = getTranscriptById(ctx.db, job.sourceTranscriptId)
      if (!source) {
        failTranslationJob(ctx.db, job.id, 'The source transcript disappeared.', Date.now())
        reply.send({ job: null })
        return
      }

      reply.send({
        job: toTranslationJobDTO(job),
        source: {
          transcriptId: source.transcript.id,
          language: source.transcript.language,
          plainText: source.transcript.plainText,
          segments: source.segments,
        },
        model: {
          id: job.modelId,
          revision: job.modelRevision,
          sha256: job.modelSha256,
          promptVersion: job.promptVersion,
          pipelineVersion: job.pipelineVersion,
        },
      })
    })

    scope.post(`${WORKER_PREFIX}/jobs/:id/heartbeat`, async (request, reply) => {
      const params = parseInput(idParams, request.params, reply)
      if (!params) return
      const body = parseInput(heartbeatBody, request.body ?? {}, reply)
      if (!body) return

      if (!heartbeatTranslationJob(ctx.db, params.id, body.owner, Date.now())) {
        reply.code(409).send(leaseLost())
        return
      }
      reply.code(204).send()
    })

    scope.post(`${WORKER_PREFIX}/jobs/:id/progress`, async (request, reply) => {
      const params = parseInput(idParams, request.params, reply)
      if (!params) return
      const body = parseInput(progressBody, request.body ?? {}, reply)
      if (!body) return

      const kept = updateTranslationProgress(
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
        reply.code(409).send(leaseLost())
        return
      }
      reply.code(204).send()
    })

    scope.post(`${WORKER_PREFIX}/jobs/:id/complete`, { bodyLimit: COMPLETE_BODY_LIMIT }, async (request, reply) => {
      const params = parseInput(idParams, request.params, reply)
      if (!params) return
      const body = parseInput(completeBody, request.body ?? {}, reply)
      if (!body) return

      const job = getTranslationJob(ctx.db, params.id)
      if (!job || job.leaseOwner !== body.owner) {
        reply.code(409).send(leaseLost())
        return
      }
      if (path.isAbsolute(body.resultDir) || body.resultDir.split(/[\\/]/).includes('..')) {
        reply.code(400).send({ error: 'invalid_request', message: 'resultDir must be relative.' })
        return
      }

      const source = getTranscriptById(ctx.db, job.sourceTranscriptId)
      if (!source) {
        reply.code(409).send({
          error: 'source_changed',
          message: 'The source transcript was replaced. Translate it again.',
        })
        return
      }

      // The translation must cover every source cue at the source timing. A
      // missing, extra, or shifted cue would put text under the wrong audio.
      const mismatch =
        body.segments.length !== source.segments.length ||
        body.segments.some((segment, index) => {
          const origin = source.segments[index]
          return (
            !origin ||
            segment.seq !== origin.seq ||
            segment.startMs !== origin.startMs ||
            segment.endMs !== origin.endMs
          )
        })
      if (mismatch) {
        reply.code(422).send({
          error: 'segment_mismatch',
          message: 'Translated cues must match the source cue count, order, and timings.',
        })
        return
      }

      const stored = completeTranslationJob(
        ctx.db,
        {
          jobId: job.id,
          owner: body.owner,
          translationId: body.translationId,
          resultDir: body.resultDir,
          plainText: body.plainText,
          segments: body.segments,
        },
        Date.now(),
      )
      if (!stored) {
        reply.code(409).send(leaseLost())
        return
      }
      reply.send({ translationId: stored.id })
    })

    scope.post(`${WORKER_PREFIX}/jobs/:id/fail`, async (request, reply) => {
      const params = parseInput(idParams, request.params, reply)
      if (!params) return
      const body = parseInput(failBody, request.body ?? {}, reply)
      if (!body) return

      const job = getTranslationJob(ctx.db, params.id)
      if (!job || job.leaseOwner !== body.owner) {
        reply.code(409).send(leaseLost())
        return
      }

      const state = failTranslationJob(ctx.db, job.id, body.message, Date.now())
      reply.send({ state })
    })
  })
}
