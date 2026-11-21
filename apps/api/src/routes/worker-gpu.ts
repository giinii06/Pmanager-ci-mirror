import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
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

type WorkerKind = 'asr' | 'translation' | 'embedding' | 'scene'
const owner = z.string().min(1).max(128)
const leaseToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const acquireBody = z.object({
  owner,
  taskKind: z.enum(['asr', 'translation', 'embedding', 'scene']),
  // Generated once by the client for a single acquire request. Retries keep it.
  acquisitionId: z.string().regex(/^[A-Za-z0-9_-]{24,64}$/),
  leaseMs: z.number().int().min(10_000).max(MAX_LEASE_MS).optional(),
})
const heartbeatBody = z.object({ owner, leaseToken })

function tokenMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function leaseLost(): { error: string; message: string } {
  return { error: 'lease_lost', message: 'This worker no longer owns the lease.' }
}

/**
 * The database stores a signed owner key, not a client-chosen owner. The nonce
 * stays only in the acquire request, and the resulting capability is never
 * stored in or exposed through the GPU lease row or status endpoints.
 */
function signedOwner(
  secret: string,
  kind: WorkerKind,
  logicalOwner: string,
  acquisitionId: string,
): string {
  const signature = createHmac('sha256', secret)
    .update(['gpu-owner-v1', kind, logicalOwner, acquisitionId].join('\0'))
    .digest('base64url')
  return `${kind}:${logicalOwner}:${signature}`
}

function leaseCapability(secret: string, resourceId: string, signed: string): string {
  return createHmac('sha256', secret)
    .update(['gpu-capability-v1', resourceId, signed].join('\0'))
    .digest('base64url')
}

/**
 * Clients share a single GPU, but each authenticated worker type may acquire
 * only its own kind of work. A signed capability is required to renew/release,
 * even for another process that knows the same worker API token and owner name.
 */
export function registerWorkerGpuRoutes(app: FastifyInstance, ctx: AppContext): void {
  const configuredWorkers: Array<{ kind: WorkerKind; token: string }> = [
    { kind: 'asr', token: ctx.config.asr.workerToken },
    { kind: 'translation', token: ctx.config.translation.workerToken },
    { kind: 'embedding', token: ctx.config.embedding.workerToken },
    { kind: 'scene', token: ctx.config.scene.workerToken },
  ]
  const workers = configuredWorkers.filter((worker) => worker.token.length >= 16)
  if (workers.length === 0) return

  const authorizedKinds = new WeakMap<FastifyRequest, WorkerKind>()
  const resourceId = ctx.config.gpu.resourceId

  app.register(async (scope) => {
    scope.addHook('onRequest', async (request: FastifyRequest, reply) => {
      const header = request.headers['x-worker-token']
      const token = Array.isArray(header) ? header[0] : header
      const matched = token ? workers.filter((worker) => tokenMatches(token, worker.token)) : []
      // A token reused by different kinds must not grant either identity.
      if (matched.length !== 1) {
        reply.code(401).send({ error: 'unauthorized', message: 'Worker token is missing or ambiguous.' })
        return reply
      }
      authorizedKinds.set(request, matched[0]!.kind)
    })

    function authorizedLease(
      request: FastifyRequest,
      body: z.infer<typeof heartbeatBody>,
    ): string | null {
      const kind = authorizedKinds.get(request)
      const lease = getGpuLease(ctx.db, resourceId)
      if (!kind || !lease || lease.leaseExpiresAt <= Date.now()) return null
      if (!lease.owner.startsWith(`${kind}:${body.owner}:`)) return null
      const expected = leaseCapability(ctx.config.authSecret, resourceId, lease.owner)
      return tokenMatches(body.leaseToken, expected) ? lease.owner : null
    }

    scope.post('/worker/gpu/acquire', async (request, reply) => {
      const body = parseInput(acquireBody, request.body ?? {}, reply)
      if (!body) return
      const kind = authorizedKinds.get(request)!
      if (body.taskKind !== kind) {
        reply.code(403).send({ error: 'wrong_worker_kind', message: 'This token cannot acquire that GPU task kind.' })
        return
      }

      const signed = signedOwner(ctx.config.authSecret, kind, body.owner, body.acquisitionId)
      const acquired = acquireGpuLease(
        ctx.db,
        { resourceId, owner: signed, taskKind: kind, leaseMs: body.leaseMs ?? LEASE_MS },
        Date.now(),
      )
      reply.send({
        acquired,
        lease: acquired ? getGpuLease(ctx.db, resourceId) : null,
        leaseToken: acquired ? leaseCapability(ctx.config.authSecret, resourceId, signed) : null,
      })
    })

    scope.post('/worker/gpu/heartbeat', async (request, reply) => {
      const body = parseInput(heartbeatBody, request.body ?? {}, reply)
      if (!body) return
      const signed = authorizedLease(request, body)
      if (!signed || !heartbeatGpuLease(ctx.db, resourceId, signed, Date.now())) {
        reply.code(409).send(leaseLost())
        return
      }
      reply.code(204).send()
    })

    scope.post('/worker/gpu/release', async (request, reply) => {
      const body = parseInput(heartbeatBody, request.body ?? {}, reply)
      if (!body) return
      const signed = authorizedLease(request, body)
      if (!signed || !releaseGpuLease(ctx.db, resourceId, signed, Date.now())) {
        reply.code(409).send(leaseLost())
        return
      }
      reply.code(204).send()
    })
  })
}
