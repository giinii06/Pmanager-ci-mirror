import { createHash, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  claimFaceJob,
  completeFaceJob,
  failFaceJob,
  getAssetFileInfo,
  getFaceJob,
  getLibrary,
  heartbeatFaceJob,
  recoverExpiredFaceJobs,
  updateFaceProgress,
  type FaceVectorInput,
} from '@mediavault/database'
import type { AppContext } from '../context'
import { toFaceJobDTO } from '../dto'
import { parseInput } from '../validate'

const WORKER_PREFIX = '/worker/face'
const LEASE_MS = 180_000
const MAX_LEASE_MS = 900_000

/** 3000 faces of 512 float32 as base64, near 6 MB. */
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
  state: z.enum(['detecting', 'writing']),
  stage: z.enum(['sampling', 'detecting', 'writing']),
  progress: z.number().min(0).max(99),
})

const completeBody = z.object({
  owner,
  faces: z
    .array(
      z.object({
        frameMs: z.number().int().min(0),
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().positive(),
        height: z.number().finite().positive(),
        score: z.number().min(0).max(1),
        thumbnailPath: z.string().min(1).max(512).nullable(),
        vector: z.string().min(1),
      }),
    )
    .max(5_000),
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

export function registerWorkerFaceRoutes(app: FastifyInstance, ctx: AppContext): void {
  if (!ctx.config.face.enabled) return

  app.register(async (scope) => {
    scope.addHook('onRequest', async (request: FastifyRequest, reply) => {
      const header = request.headers['x-worker-token']
      const token = Array.isArray(header) ? header[0] : header
      if (!token || !tokenMatches(token, ctx.config.face.workerToken)) {
        reply.code(401).send(denied())
        return reply
      }
    })

    scope.post(`${WORKER_PREFIX}/claim`, async (request, reply) => {
      const body = parseInput(claimBody, request.body ?? {}, reply)
      if (!body) return

      const now = Date.now()
      recoverExpiredFaceJobs(ctx.db, now)

      const job = claimFaceJob(ctx.db, body.owner, body.leaseMs ?? LEASE_MS, now)
      if (!job) {
        reply.send({ job: null })
        return
      }

      const info = getAssetFileInfo(ctx.db, job.assetId)
      const library = info ? getLibrary(ctx.db, info.libraryId) : null
      if (!info || !library || info.deletedAt !== null) {
        failFaceJob(ctx.db, job.id, 'The asset disappeared before processing.', Date.now())
        reply.send({ job: null })
        return
      }

      reply.send({
        job: toFaceJobDTO(job),
        media: {
          path: path.posix.join(library.rootPath, info.relativePath),
          filename: info.filename,
          durationMs: info.durationMs,
        },
        model: {
          id: job.modelId,
          revision: job.modelRevision,
          sha256: job.modelSha256,
          pipelineVersion: job.pipelineVersion,
          dimensions: job.dimensions,
        },
        sampleMs: job.sampleMs,
      })
    })

    scope.post(`${WORKER_PREFIX}/jobs/:id/heartbeat`, async (request, reply) => {
      const params = parseInput(idParams, request.params, reply)
      if (!params) return
      const body = parseInput(heartbeatBody, request.body ?? {}, reply)
      if (!body) return

      if (!heartbeatFaceJob(ctx.db, params.id, body.owner, Date.now())) {
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

      const kept = updateFaceProgress(
        ctx.db,
        params.id,
        body.owner,
        { state: body.state, stage: body.stage, progress: body.progress },
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

        const job = getFaceJob(ctx.db, params.id)
        if (!job || job.leaseOwner !== body.owner) {
          reply.code(409).send(leaseLost())
          return
        }

        const faces: FaceVectorInput[] = []
        for (const item of body.faces) {
          const vector = decodeVector(item.vector, job.dimensions)
          if (!vector) {
            reply.code(422).send({
              error: 'invalid_vector',
              message: `Each vector must be ${job.dimensions} finite float32 values of unit length, base64 encoded.`,
            })
            return
          }
          faces.push({ ...item, vector })
        }

        const stored = completeFaceJob(
          ctx.db,
          {
            jobId: job.id,
            owner: body.owner,
            faces,
            matchThreshold: ctx.config.face.matchThreshold,
            candidateThreshold: ctx.config.face.candidateThreshold,
          },
          Date.now(),
        )
        if (!stored) {
          reply.code(409).send(leaseLost())
          return
        }
        reply.send({ faces: faces.length })
      },
    )

    scope.post(`${WORKER_PREFIX}/jobs/:id/fail`, async (request, reply) => {
      const params = parseInput(idParams, request.params, reply)
      if (!params) return
      const body = parseInput(failBody, request.body ?? {}, reply)
      if (!body) return

      const job = getFaceJob(ctx.db, params.id)
      if (!job || job.leaseOwner !== body.owner) {
        reply.code(409).send(leaseLost())
        return
      }

      const state = failFaceJob(ctx.db, job.id, body.message, Date.now())
      reply.send({ state })
    })
  })
}
