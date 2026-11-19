import { createHash, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  claimSceneJob,
  completeSceneJob,
  deleteStageCheckpoints,
  failSceneJob,
  getAssetFileInfo,
  getLibrary,
  getSceneJob,
  getStageCheckpoint,
  heartbeatSceneJob,
  recoverExpiredSceneJobs,
  updateSceneProgress,
  upsertStageCheckpoint,
  type Db,
  type SceneVectorInput,
} from '@mediavault/database'
import type { AppContext } from '../context'
import { toSceneJobDTO } from '../dto'
import { parseInput } from '../validate'

const WORKER_PREFIX = '/worker/scene'
const LEASE_MS = 120_000
const MAX_LEASE_MS = 900_000

/** 300 windows of three 1024-dim float32 vectors, base64, near 5 MB. */
const COMPLETE_BODY_LIMIT = 24 * 1024 * 1024

const idParams = z.object({ id: z.string().min(1).max(64) })
const owner = z.string().min(1).max(128)

const claimBody = z.object({
  owner,
  leaseMs: z.number().int().min(10_000).max(MAX_LEASE_MS).optional(),
})

const heartbeatBody = z.object({ owner })

const progressBody = z.object({
  owner,
  state: z.enum(['extracting', 'embedding', 'writing']),
  stage: z.enum(['extracting', 'embedding', 'writing']),
  progress: z.number().min(0).max(99),
})

const completeBody = z.object({
  owner,
  coverage: z
    .object({
      analyzed: z.number().int().min(0).max(100_000),
      total: z.number().int().min(1).max(100_000),
    })
    .refine((value) => value.analyzed <= value.total, {
      message: 'analyzed cannot exceed total',
    })
    .optional(),
  scenes: z
    .array(
      z.object({
        seq: z.number().int().min(0),
        startMs: z.number().int().min(0),
        endMs: z.number().int().min(0),
        thumbnailPath: z.string().min(1).max(512).nullable(),
        visual: z.string().min(1),
        audio: z.string().min(1),
        av: z.string().min(1),
      }),
    )
    .min(1)
    .max(5_000),
})

const checkpointBody = z.object({
  owner,
  stage: z.literal('extracting'),
  completedUnits: z.number().int().min(0).max(100_000),
  totalUnits: z.number().int().min(1).max(100_000),
  manifestPath: z.string().min(1).max(512),
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
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

/** Identifies the weights and preprocessing that produced a checkpoint. */
function sceneFingerprint(job: {
  modelId: string
  modelRevision: string
  modelSha256: string
}): string {
  return `${job.modelId}@${job.modelRevision}#${job.modelSha256}`
}

/**
 * A checkpoint is only usable for the same model and pipeline. A mismatch
 * deletes it, because reusing windows from another model would publish vectors
 * the index cannot compare.
 */
function liveCheckpoint(
  db: Db,
  job: {
    id: string
    pipelineVersion: string
    modelId: string
    modelRevision: string
    modelSha256: string
  },
) {
  const checkpoint = getStageCheckpoint(db, job.id, 'extracting')
  if (!checkpoint) return null
  if (
    checkpoint.modelFingerprint !== sceneFingerprint(job) ||
    checkpoint.pipelineVersion !== job.pipelineVersion ||
    checkpoint.completedUnits <= 0 ||
    checkpoint.completedUnits > checkpoint.totalUnits
  ) {
    deleteStageCheckpoints(db, job.id)
    return null
  }
  return checkpoint
}

export function registerWorkerSceneRoutes(app: FastifyInstance, ctx: AppContext): void {
  if (!ctx.config.scene.enabled) return

  app.register(async (scope) => {
    scope.addHook('onRequest', async (request: FastifyRequest, reply) => {
      const header = request.headers['x-worker-token']
      const token = Array.isArray(header) ? header[0] : header
      if (!token || !tokenMatches(token, ctx.config.scene.workerToken)) {
        reply.code(401).send(denied())
        return reply
      }
    })

    scope.post(`${WORKER_PREFIX}/claim`, async (request, reply) => {
      const body = parseInput(claimBody, request.body ?? {}, reply)
      if (!body) return

      const now = Date.now()
      recoverExpiredSceneJobs(ctx.db, now)

      const job = claimSceneJob(ctx.db, body.owner, body.leaseMs ?? LEASE_MS, now)
      if (!job) {
        reply.send({ job: null })
        return
      }

      const info = getAssetFileInfo(ctx.db, job.assetId)
      const library = info ? getLibrary(ctx.db, info.libraryId) : null
      if (!info || !library || info.deletedAt !== null) {
        failSceneJob(ctx.db, job.id, 'The asset disappeared before processing.', Date.now())
        reply.send({ job: null })
        return
      }

      const checkpoint = liveCheckpoint(ctx.db, job)
      reply.send({
        job: toSceneJobDTO(job),
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
        window: { windowMs: job.windowMs, overlapMs: job.overlapMs },
        checkpoint: checkpoint
          ? {
              stage: checkpoint.stageName,
              completedUnits: checkpoint.completedUnits,
              totalUnits: checkpoint.totalUnits,
              manifestPath: checkpoint.artifactManifest,
              manifestHash: checkpoint.manifestHash,
            }
          : null,
      })
    })

    scope.post(`${WORKER_PREFIX}/jobs/:id/heartbeat`, async (request, reply) => {
      const params = parseInput(idParams, request.params, reply)
      if (!params) return
      const body = parseInput(heartbeatBody, request.body ?? {}, reply)
      if (!body) return

      if (!heartbeatSceneJob(ctx.db, params.id, body.owner, Date.now())) {
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

      const kept = updateSceneProgress(
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

    scope.post(`${WORKER_PREFIX}/jobs/:id/checkpoint`, async (request, reply) => {
      const params = parseInput(idParams, request.params, reply)
      if (!params) return
      const body = parseInput(checkpointBody, request.body ?? {}, reply)
      if (!body) return

      const now = Date.now()
      const job = getSceneJob(ctx.db, params.id)
      if (
        !job ||
        job.leaseOwner !== body.owner ||
        job.leaseExpiresAt === null ||
        job.leaseExpiresAt <= now ||
        !['extracting', 'embedding', 'writing'].includes(job.state)
      ) {
        reply.code(409).send(leaseLost())
        return
      }
      if (body.completedUnits > body.totalUnits) {
        reply.code(422).send({
          error: 'invalid_checkpoint',
          message: 'completedUnits cannot exceed totalUnits.',
        })
        return
      }

      const checkpoint = upsertStageCheckpoint(
        ctx.db,
        {
          jobId: job.id,
          pipeline: 'scene',
          assetId: job.assetId,
          fileVersion: job.fileVersion,
          modelFingerprint: sceneFingerprint(job),
          pipelineVersion: job.pipelineVersion,
          stageName: body.stage,
          completedUnits: body.completedUnits,
          totalUnits: body.totalUnits,
          artifactManifest: body.manifestPath,
          manifestHash: body.manifestHash,
        },
        now,
      )
      reply.send({
        checkpoint: {
          completedUnits: checkpoint.completedUnits,
          totalUnits: checkpoint.totalUnits,
        },
      })
    })

    scope.post(
      `${WORKER_PREFIX}/jobs/:id/complete`,
      { bodyLimit: COMPLETE_BODY_LIMIT },
      async (request, reply) => {
        const params = parseInput(idParams, request.params, reply)
        if (!params) return
        const body = parseInput(completeBody, request.body ?? {}, reply)
        if (!body) return

        const job = getSceneJob(ctx.db, params.id)
        if (!job || job.leaseOwner !== body.owner) {
          reply.code(409).send(leaseLost())
          return
        }

        const scenes: SceneVectorInput[] = []
        for (const item of body.scenes) {
          const visual = decodeVector(item.visual, job.dimensions)
          const audio = decodeVector(item.audio, job.dimensions)
          const av = decodeVector(item.av, job.dimensions)
          if (!visual || !audio || !av) {
            reply.code(422).send({
              error: 'invalid_vector',
              message: `Each vector must be ${job.dimensions} finite float32 values of unit length, base64 encoded.`,
            })
            return
          }
          scenes.push({ ...item, visual, audio, av })
        }

        const stored = completeSceneJob(
          ctx.db,
          { jobId: job.id, owner: body.owner, scenes, coverage: body.coverage },
          Date.now(),
        )
        if (!stored) {
          reply.code(409).send(leaseLost())
          return
        }
        reply.send({ scenes: scenes.length })
      },
    )

    scope.post(`${WORKER_PREFIX}/jobs/:id/fail`, async (request, reply) => {
      const params = parseInput(idParams, request.params, reply)
      if (!params) return
      const body = parseInput(failBody, request.body ?? {}, reply)
      if (!body) return

      const job = getSceneJob(ctx.db, params.id)
      if (!job || job.leaseOwner !== body.owner) {
        reply.code(409).send(leaseLost())
        return
      }

      const state = failSceneJob(ctx.db, job.id, body.message, Date.now())
      reply.send({ state })
    })
  })
}
