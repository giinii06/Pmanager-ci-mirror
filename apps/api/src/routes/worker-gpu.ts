import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  acquireGpuLease,
  getGpuLease,
  heartbeatGpuLease,
  releaseGpuLease,
} from '@mediavault/database'
import type { AppContext } from '../context'
import { parseInput } from '../validate'

const LEASE_MS = 120_000
const MAX_LEASE_MS = 600_000

const owner = z.string().min(1).max(128)
const acquireBody = z.object({
  owner,
  taskKind: z.string().min(1).max(32),
  leaseMs: z.number().int().min(10_000).max(MAX_LEASE_MS).optional(),
})
const heartbeatBody = z.object({ owner })

function tokenMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function leaseLost(): { error: string; message: string } {
  return { error: 'lease_lost', message: 'This worker no longer owns the lease.' }
}

/**
 * One card, one lease. ASR and translation workers both authenticate here with
 * their own token, so either can take the card but never at the same time.
 */
export function registerWorkerGpuRoutes(app: FastifyInstance, ctx: AppContext): void {
  const tokens = [ctx.config.asr.workerToken, ctx.config.translation.workerToken].filter(
    (token) => token.length >= 16,
  )
  if (tokens.length === 0) return

  app.register(async (scope) => {
    scope.addHook('onRequest', async (request: FastifyRequest, reply) => {
      const header = request.headers['x-worker-token']
      const token = Array.isArray(header) ? header[0] : header
      if (!token || !tokens.some((expected) => tokenMatches(token, expected))) {
        reply.code(401).send({ error: 'unauthorized', message: 'Worker token is missing or wrong.' })
        return reply
      }
    })

    scope.post('/worker/gpu/acquire', async (request, reply) => {
      const body = parseInput(acquireBody, request.body ?? {}, reply)
      if (!body) return

      const resourceId = ctx.config.translation.gpuResource
      const acquired = acquireGpuLease(
        ctx.db,
        {
          resourceId,
          owner: body.owner,
          taskKind: body.taskKind,
          leaseMs: body.leaseMs ?? LEASE_MS,
        },
        Date.now(),
      )
      reply.send({
        acquired,
        lease: acquired ? getGpuLease(ctx.db, resourceId) : null,
      })
    })

    scope.post('/worker/gpu/heartbeat', async (request, reply) => {
      const body = parseInput(heartbeatBody, request.body ?? {}, reply)
      if (!body) return

      const resourceId = ctx.config.translation.gpuResource
      if (!heartbeatGpuLease(ctx.db, resourceId, body.owner, LEASE_MS, Date.now())) {
        reply.code(409).send(leaseLost())
        return
      }
      reply.code(204).send()
    })

    scope.post('/worker/gpu/release', async (request, reply) => {
      const body = parseInput(heartbeatBody, request.body ?? {}, reply)
      if (!body) return

      releaseGpuLease(ctx.db, ctx.config.translation.gpuResource, body.owner)
      reply.code(204).send()
    })
  })
}
