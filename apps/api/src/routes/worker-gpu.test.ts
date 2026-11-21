import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, test } from 'bun:test'
import { getGpuLease, openDatabase, type Db } from '@mediavault/database'
import type { AppContext } from '../context'
import { registerWorkerGpuRoutes } from './worker-gpu'

const RESOURCE = 'gpu:0'
const ASR_TOKEN = 'asr-token-0123456789abcdefghijkl'
const SCENE_TOKEN = 'scene-token-0123456789abcdefghijkl'
const ASR_NONCE = 'asr-acquire-request-0123456789ab'
const SCENE_NONCE = 'scene-acquire-request-0123456789'
const instances: Array<{ db: Db; app: FastifyInstance }> = []

afterEach(async () => {
  for (const { db, app } of instances.splice(0)) {
    await app.close()
    db.close()
  }
})

function harness(duplicateToken = false): { db: Db; app: FastifyInstance } {
  const db = openDatabase(':memory:')
  const app = Fastify()
  const ctx = {
    db,
    config: {
      authSecret: 'gpu-lease-capability-secret-0123456789',
      gpu: { resourceId: RESOURCE },
      asr: { workerToken: ASR_TOKEN },
      scene: { workerToken: duplicateToken ? ASR_TOKEN : SCENE_TOKEN },
      translation: { workerToken: '' },
      embedding: { workerToken: '' },
    },
  } as unknown as AppContext
  registerWorkerGpuRoutes(app, ctx)
  instances.push({ db, app })
  return { db, app }
}

function token(value: string): Record<string, string> {
  return { 'x-worker-token': value }
}

function acquire(app: FastifyInstance, kind: 'asr' | 'scene', owner = 'worker-1', acquisitionId?: string) {
  return app.inject({
    method: 'POST',
    url: '/worker/gpu/acquire',
    headers: token(kind === 'asr' ? ASR_TOKEN : SCENE_TOKEN),
    payload: {
      owner,
      taskKind: kind,
      acquisitionId: acquisitionId ?? (kind === 'asr' ? ASR_NONCE : SCENE_NONCE),
    },
  })
}

function change(app: FastifyInstance, path: 'heartbeat' | 'release', auth: string, owner: string, leaseToken: string) {
  return app.inject({
    method: 'POST',
    url: `/worker/gpu/${path}`,
    headers: token(auth),
    payload: { owner, leaseToken },
  })
}

describe('GPU capability authentication', () => {
  test('the acquiring worker can renew and release only with its lease token', async () => {
    const { db, app } = harness()
    const result = await acquire(app, 'asr')
    expect(result.statusCode).toBe(200)
    expect(result.json().acquired).toBe(true)
    const capability = result.json().leaseToken as string
    expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(getGpuLease(db, RESOURCE)?.owner).not.toContain(capability)

    expect((await change(app, 'heartbeat', ASR_TOKEN, 'worker-1', capability)).statusCode).toBe(204)
    expect((await change(app, 'release', ASR_TOKEN, 'worker-1', capability)).statusCode).toBe(204)
    expect(getGpuLease(db, RESOURCE)).toBeNull()
  })

  test('a valid ASR token cannot acquire a scene lease', async () => {
    const { app } = harness()
    const rejected = await app.inject({
      method: 'POST',
      url: '/worker/gpu/acquire',
      headers: token(ASR_TOKEN),
      payload: { owner: 'worker-1', taskKind: 'scene', acquisitionId: ASR_NONCE },
    })
    expect(rejected.statusCode).toBe(403)
  })

  test('another worker cannot renew or release an ASR lease by guessing its owner', async () => {
    const { db, app } = harness()
    const issued = (await acquire(app, 'asr')).json()
    expect(issued.acquired).toBe(true)
    const capability = issued.leaseToken as string
    const actualOwner = getGpuLease(db, RESOURCE)?.owner
    expect(actualOwner).toBeTruthy()

    expect((await change(app, 'release', SCENE_TOKEN, 'worker-1', capability)).statusCode).toBe(409)
    expect((await change(app, 'heartbeat', ASR_TOKEN, 'worker-2', capability)).statusCode).toBe(409)
    expect((await change(app, 'release', ASR_TOKEN, 'worker-1', 'A'.repeat(43))).statusCode).toBe(409)
    expect(getGpuLease(db, RESOURCE)?.owner).toBe(actualOwner)
  })

  test('same request ID retries are idempotent, new requests cannot take over a live lease', async () => {
    const { db, app } = harness()
    const first = (await acquire(app, 'asr')).json()
    const repeated = (await acquire(app, 'asr')).json()
    expect(repeated.acquired).toBe(true)
    expect(repeated.leaseToken).toBe(first.leaseToken)
    expect((await acquire(app, 'asr', 'worker-1', 'another-acquire-request-0123456789')).json().acquired).toBe(false)
    expect(getGpuLease(db, RESOURCE)?.owner).toBe(first.lease.owner)
  })

  test('a stale token cannot release a new lease with the same logical owner', async () => {
    const { db, app } = harness()
    const first = (await acquire(app, 'asr')).json()
    expect((await change(app, 'release', ASR_TOKEN, 'worker-1', first.leaseToken)).statusCode).toBe(204)
    const second = (await acquire(app, 'asr', 'worker-1', 'another-acquire-request-0123456789')).json()
    expect(second.acquired).toBe(true)
    expect(second.leaseToken).not.toBe(first.leaseToken)
    expect((await change(app, 'release', ASR_TOKEN, 'worker-1', first.leaseToken)).statusCode).toBe(409)
    expect(getGpuLease(db, RESOURCE)).not.toBeNull()
  })

  test('missing or shared worker credentials fail closed', async () => {
    const { app } = harness(true)
    const response = await app.inject({
      method: 'POST',
      url: '/worker/gpu/acquire',
      headers: token(ASR_TOKEN),
      payload: { owner: 'worker-1', taskKind: 'asr', acquisitionId: ASR_NONCE },
    })
    expect(response.statusCode).toBe(401)
    const absent = await app.inject({
      method: 'POST',
      url: '/worker/gpu/acquire',
      payload: { owner: 'worker-1', taskKind: 'asr', acquisitionId: ASR_NONCE },
    })
    expect(absent.statusCode).toBe(401)
  })
})
