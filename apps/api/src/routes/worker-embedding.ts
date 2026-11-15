import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  claimEmbeddingJob,
  completeEmbeddingJob,
  failEmbeddingJob,
  getAssetFileInfo,
  getEmbeddingJob,
  getTranscriptById,
  heartbeatEmbeddingJob,
  recoverExpiredEmbeddingJobs,
  updateEmbeddingProgress,
  type EmbeddingVectorInput,
} from '@mediavault/database'
import type { AppContext } from '../context'
import { toEmbeddingJobDTO } from '../dto'
import { parseInput } from '../validate'

const WORKER_PREFIX = '/worker/embedding'
const LEASE_MS = 120_000
const MAX_LEASE_MS = 600_000

/**
 * The global limit is 1 MB. A 60-chunk video sends 60 unit vectors of 2560
 * float32 as base64, near 800 KB, so this route needs the room.
 */
const COMPLETE_BODY_LIMIT = 8 * 1024 * 1024

const idParams = z.object({ id: z.string().min(1).max(64) })
const owner = z.string().min(1).max(128)

const claimBody = z.object({
  owner,
  leaseMs: z.number().int().min(10_000).max(MAX_LEASE_MS).optional(),
})

const heartbeatBody = z.object({ owner })

const progressBody = z.object({
  owner,
  state: z.enum(['embedding', 'writing']),
  stage: z.enum(['starting', 'embedding', 'writing']),
  progress: z.number().min(0).max(99),
})

const completeBody = z.object({
  owner,
  vectors: z
    .array(
      z.object({
        kind: z.enum(['title', 'chunk']),
        chunkIndex: z.number().int().min(0),
        startMs: z.number().int().min(0).nullable(),
        endMs: z.number().int().min(0).nullable(),
        text: z.string().min(1).max(4_000),
        vector: z.string().min(1),
      }),
    )
    .min(1)
    .max(2_000),
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
 * Decodes one base64 payload of little-endian float32. The length check comes
 * first because base64 decoding is lenient: a truncated string yields a short
 * buffer instead of an error. The norm is checked here so a bad vector is a 422
 * on this route, not a throw from the store that leaves the job in `writing`.
 */
function decodeVector(encoded: string, dimensions: number): Float32Array | null {
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length !== dimensions * 4) return null

  const vector = new Float32Array(new Uint8Array(bytes).buffer)
  let sum = 0
  for (const value of vector) {
    if (!Number.isFinite(value)) return null
    sum += value * value
  }
  if (Math.abs(Math.sqrt(sum) - 1) > 1e-3) return null
  return vector
}

/**
 * The embedding worker routes live outside /api/ like the ASR and translation
 * ones: the shared token is the only credential, and nginx never exposes them.
 */
export function registerWorkerEmbeddingRoutes(app: FastifyInstance, ctx: AppContext): void {
  if (!ctx.config.embedding.enabled) return

  app.register(async (scope) => {
    scope.addHook('onRequest', async (request: FastifyRequest, reply) => {
      const header = request.headers['x-worker-token']
      const token = Array.isArray(header) ? header[0] : header
      if (!token || !tokenMatches(token, ctx.config.embedding.workerToken)) {
        reply.code(401).send(denied())
        return reply
      }
    })

    scope.post(`${WORKER_PREFIX}/claim`, async (request, reply) => {
      const body = parseInput(claimBody, request.body ?? {}, reply)
      if (!body) return

      const now = Date.now()
      recoverExpiredEmbeddingJobs(ctx.db, now)

      const job = claimEmbeddingJob(ctx.db, body.owner, body.leaseMs ?? LEASE_MS, now)
      if (!job) {
        reply.send({ job: null })
        return
      }

      const asset = getAssetFileInfo(ctx.db, job.assetId)
      if (!asset || asset.deletedAt !== null) {
        failEmbeddingJob(ctx.db, job.id, 'The asset disappeared before processing.', Date.now())
        reply.send({ job: null })
        return
      }

      const source = job.sourceTranscriptId ? getTranscriptById(ctx.db, job.sourceTranscriptId) : null

      reply.send({
        job: toEmbeddingJobDTO(job),
        asset: { id: asset.id, filename: asset.filename, fileVersion: job.fileVersion },
        text: {
          language: source?.transcript.language ?? null,
          transcriptId: source?.transcript.id ?? null,
          segments:
            source?.segments.map((segment) => ({
              startMs: segment.startMs,
              endMs: segment.endMs,
              text: segment.text,
            })) ?? [],
        },
        model: {
          id: job.modelId,
          revision: job.modelRevision,
          sha256: job.modelSha256,
          pipelineVersion: job.pipelineVersion,
          dimensions: job.dimensions,
        },
      })
    })

    scope.post(`${WORKER_PREFIX}/jobs/:id/heartbeat`, async (request, reply) => {
      const params = parseInput(idParams, request.params, reply)
      if (!params) return
      const body = parseInput(heartbeatBody, request.body ?? {}, reply)
      if (!body) return

      if (!heartbeatEmbeddingJob(ctx.db, params.id, body.owner, LEASE_MS, Date.now())) {
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

      const kept = updateEmbeddingProgress(
        ctx.db,
        params.id,
        body.owner,
        {
          state: body.state,
          stage: body.stage,
          progress: body.progress,
          leaseMs: LEASE_MS,
        },
        Date.now(),
      )
      if (!kept) {
        reply.code(409).send(leaseLost())
        return
      }
      reply.code(204).send()
    })

    scope.post(
      `${WORKER_PREFIX}/jobs/:id/complete`,
      { bodyLimit: COMPLETE_BODY_LIMIT },
      async (request, reply) => {
        const params = parseInput(idParams, request.params, reply)
        if (!params) return
        const body = parseInput(completeBody, request.body ?? {}, reply)
        if (!body) return

        const job = getEmbeddingJob(ctx.db, params.id)
        if (!job || job.leaseOwner !== body.owner) {
          reply.code(409).send(leaseLost())
          return
        }

        const vectors: EmbeddingVectorInput[] = []
        for (const item of body.vectors) {
          const vector = decodeVector(item.vector, job.dimensions)
          if (!vector) {
            reply.code(422).send({
              error: 'invalid_vector',
              message: `Each vector must be ${job.dimensions} finite float32 values of unit length, base64 encoded.`,
            })
            return
          }
          vectors.push({ ...item, vector })
        }

        const stored = completeEmbeddingJob(
          ctx.db,
          { jobId: job.id, owner: body.owner, vectors },
          Date.now(),
        )
        if (!stored) {
          reply.code(409).send(leaseLost())
          return
        }
        reply.send({ embedded: vectors.length })
      },
    )

    scope.post(`${WORKER_PREFIX}/jobs/:id/fail`, async (request, reply) => {
      const params = parseInput(idParams, request.params, reply)
      if (!params) return
      const body = parseInput(failBody, request.body ?? {}, reply)
      if (!body) return

      const job = getEmbeddingJob(ctx.db, params.id)
      if (!job || job.leaseOwner !== body.owner) {
        reply.code(409).send(leaseLost())
        return
      }

      const state = failEmbeddingJob(ctx.db, job.id, body.message, Date.now())
      reply.send({ state })
    })
  })
}
