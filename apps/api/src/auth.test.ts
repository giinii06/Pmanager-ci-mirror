import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createUser, openDatabase } from '@mediavault/database'
import { buildApp } from './app'
import { hashPassword } from './auth'
import type { ApiConfig } from './config'
import type { AppContext } from './context'
import { Semaphore } from './semaphore'

const SECRET = 'test-secret-for-session-signing'
const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

function apiConfig(dir: string): ApiConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    cacheDir: dir,
    mediaRoot: dir,
    authSecret: SECRET,
    accel: false,
    hwaccel: null,
    secureCookies: false,
    scanIntervalMs: 15 * 60_000,
    fileMutationEnabled: false,
    gpu: { resourceId: 'gpu:0' },
    asr: {
      enabled: false,
      workerToken: '',
      resultDir: dir,
      modelRevision: 'asr-rev',
      alignerRevision: 'align-rev',
      pipelineVersion: 'asr-1',
      retryMs: 15 * 60_000,
    },
    translation: {
      enabled: false,
      workerToken: '',
      resultDir: dir,
      modelId: 'model',
      modelRevision: 'commit-sha',
      modelSha256: 'sha-tr',
      promptVersion: '1',
      pipelineVersion: 'tr-1',
      targetLanguage: 'ko',
    },
    embedding: {
      enabled: false,
      workerToken: '',
      modelId: 'model',
      modelRevision: 'commit-sha',
      modelSha256: 'sha-emb',
      pipelineVersion: 'emb-1',
      dimensions: 2,
    },
    scene: {
      enabled: false,
      workerToken: '',
      modelId: 'facebook/pe-av-base-16-frame',
      modelRevision: 'main',
      modelSha256: 'scene-sha',
      pipelineVersion: 'scene-1',
      dimensions: 4,
      windowMs: 10_000,
      overlapMs: 2_000,
      queryUrl: 'http://127.0.0.1:1',
    },
  }
}

async function harness() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mediavault-auth-'))
  dirs.push(dir)
  const db = openDatabase(':memory:')
  const ctx: AppContext = {
    config: apiConfig(dir),
    db,
    thumbnails: new Semaphore(1),
    previews: new Semaphore(1),
  }
  return { db, app: await buildApp(ctx) }
}

describe('sign-in', () => {
  test('a password shorter than the setup minimum still signs in', async () => {
    const h = await harness()
    createUser(h.db, {
      id: 'user-xo',
      username: 'xo',
      passwordHash: await hashPassword('798808'),
      createdAt: 1,
    })

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'xo', password: '798808' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['set-cookie']).toContain('mv_session=')
    await h.app.close()
  })

  test('a wrong password is refused', async () => {
    const h = await harness()
    createUser(h.db, {
      id: 'user-xo',
      username: 'xo',
      passwordHash: await hashPassword('798808'),
      createdAt: 1,
    })

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'xo', password: '798809' },
    })

    expect(response.statusCode).toBe(401)
    await h.app.close()
  })

  test('setup still refuses a password under eight characters', async () => {
    const h = await harness()

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'xo', password: '798808' },
    })

    expect(response.statusCode).toBe(400)
    await h.app.close()
  })
})
