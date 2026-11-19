import { afterAll, describe, expect, test } from 'bun:test'
import { randomBytes, scryptSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createUser, findUserByUsername, openDatabase } from '@mediavault/database'
import { buildApp } from './app'
import {
  SESSION_COOKIE,
  createSession,
  hashPassword,
  parseCookies,
  verifyPassword,
} from './auth'
import type { ApiConfig } from './config'
import type { AppContext } from './context'
import { admitLogin, finishLogin } from './login-guard'
import { Semaphore } from './semaphore'

const SECRET = 'test-secret-for-session-signing'
const WORKER_TOKEN = 'test-worker-token-0123456789'
const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

function apiConfig(dir: string, trustProxy: string[]): ApiConfig {
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
    hlsGenerationsEnabled: false,
    trustProxy,
    publicOrigins: [],
    gpu: { resourceId: 'gpu:0' },
    asr: {
      enabled: false,
      workerToken: WORKER_TOKEN,
      resultDir: dir,
      modelRevision: 'asr-rev',
      alignerRevision: 'align-rev',
      pipelineVersion: 'asr-1',
      retryMs: 15 * 60_000,
    },
    translation: {
      enabled: false,
      workerToken: WORKER_TOKEN,
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
      workerToken: WORKER_TOKEN,
      modelId: 'model',
      modelRevision: 'commit-sha',
      modelSha256: 'sha-emb',
      pipelineVersion: 'emb-1',
      dimensions: 2,
    },
    scene: {
      enabled: false,
      workerToken: WORKER_TOKEN,
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

async function harness(options: { trustProxy?: string[] } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mediavault-sessions-'))
  dirs.push(dir)
  const db = openDatabase(':memory:')
  const ctx: AppContext = {
    config: apiConfig(dir, options.trustProxy ?? []),
    db,
    thumbnails: new Semaphore(1),
    previews: new Semaphore(1),
  }
  return { db, app: await buildApp(ctx) }
}

async function addUser(db: ReturnType<typeof openDatabase>, username: string, password: string) {
  const user = {
    id: `user-${username}`,
    username,
    passwordHash: await hashPassword(password),
    createdAt: 1,
  }
  createUser(db, user)
  return user
}

function sessionFrom(response: { headers: Record<string, unknown> }): string {
  const header = String(response.headers['set-cookie'] ?? '')
  const match = /mv_session=([A-Za-z0-9_-]{43})/.exec(header)
  if (!match) throw new Error(`no session cookie in ${header}`)
  return `${SESSION_COOKIE}=${match[1]}`
}

function legacyScryptHash(password: string): string {
  const salt = randomBytes(16)
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 })
  return ['scrypt', 16384, 8, 1, salt.toString('base64url'), key.toString('base64url')].join('$')
}

describe('password hashing', () => {
  test('new hashes are argon2id and verify', async () => {
    const hash = await hashPassword('secret123')
    expect(hash.startsWith('$argon2id$')).toBe(true)
    expect(await verifyPassword('secret123', hash)).toEqual({ ok: true, needsRehash: false })
    expect(await verifyPassword('secret124', hash)).toEqual({ ok: false, needsRehash: false })
  })

  test('a legacy scrypt hash verifies and asks for a rehash', async () => {
    const hash = legacyScryptHash('secret123')
    expect(await verifyPassword('secret123', hash)).toEqual({ ok: true, needsRehash: true })
    expect(await verifyPassword('nope', hash)).toEqual({ ok: false, needsRehash: true })
  })

  test('a malformed or oversized scrypt hash is a failure, not an exception', async () => {
    for (const stored of [
      'scrypt$1073741824$32$16$AAAA$AAAA',
      'scrypt$16384$8$1$AAAA$AAAA',
      'scrypt$16384$8$1$not-base64!!$also-bad!!',
      'nonsense',
      '',
    ]) {
      expect(await verifyPassword('secret123', stored)).toEqual({ ok: false, needsRehash: false })
    }
  })

  test('a legacy login upgrades the stored hash', async () => {
    const h = await harness()
    const user = {
      id: 'user-legacy',
      username: 'legacy',
      passwordHash: legacyScryptHash('oldpass1'),
      createdAt: 1,
    }
    createUser(h.db, user)

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'legacy', password: 'oldpass1' },
    })
    expect(response.statusCode).toBe(200)
    const stored = findUserByUsername(h.db, 'legacy')!
    expect(stored.passwordHash.startsWith('$argon2id$')).toBe(true)
    await h.app.close()
  })
})

describe('sessions', () => {
  test('login issues a hardened cookie and logout revokes it', async () => {
    const h = await harness()
    await addUser(h.db, 'xo', 'password1')

    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'xo', password: 'password1' },
    })
    expect(login.statusCode).toBe(200)
    const cookie = String(login.headers['set-cookie'])
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Max-Age=2592000')
    expect(login.headers['cache-control']).toBe('no-store')

    const headers = { cookie: sessionFrom(login) }
    const status = await h.app.inject({ method: 'GET', url: '/api/auth/status', headers })
    expect((status.json() as { authenticated: boolean }).authenticated).toBe(true)

    const logout = await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers })
    expect(logout.statusCode).toBe(204)

    const after = await h.app.inject({ method: 'GET', url: '/api/auth/status', headers })
    expect((after.json() as { authenticated: boolean }).authenticated).toBe(false)
    const blocked = await h.app.inject({ method: 'GET', url: '/api/libraries', headers })
    expect(blocked.statusCode).toBe(401)
    await h.app.close()
  })

  test('the session list marks the caller and revoking another session kills it', async () => {
    const h = await harness()
    await addUser(h.db, 'xo', 'password1')
    const login = async () =>
      h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'xo', password: 'password1' },
      })

    const first = await login()
    const second = await login()
    const headers = { cookie: sessionFrom(first) }
    const otherHeaders = { cookie: sessionFrom(second) }

    const list = await h.app.inject({ method: 'GET', url: '/api/auth/sessions', headers })
    expect(list.statusCode).toBe(200)
    const sessions = (list.json() as { sessions: Array<{ id: string; current: boolean }> }).sessions
    expect(sessions).toHaveLength(2)
    expect(sessions.filter((session) => session.current)).toHaveLength(1)

    const other = sessions.find((session) => !session.current)!
    const revoked = await h.app.inject({
      method: 'DELETE',
      url: `/api/auth/sessions/${other.id}`,
      headers,
    })
    expect(revoked.statusCode).toBe(204)
    const gone = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: otherHeaders })
    expect(gone.statusCode).toBe(401)

    const unknown = await h.app.inject({
      method: 'DELETE',
      url: '/api/auth/sessions/zzzzzzzzzzzz',
      headers,
    })
    expect(unknown.statusCode).toBe(404)
    await h.app.close()
  })

  test('a session belongs to its user', async () => {
    const h = await harness()
    const owner = await addUser(h.db, 'owner', 'password1')
    await addUser(h.db, 'other', 'password2')
    const ownerSession = createSession(h.db, owner.id, SECRET)
    const otherSession = createSession(h.db, 'user-other', SECRET)

    const response = await h.app.inject({
      method: 'DELETE',
      url: `/api/auth/sessions/${otherSession.id}`,
      headers: { cookie: `${SESSION_COOKIE}=${ownerSession.token}` },
    })
    expect(response.statusCode).toBe(404)
    const stillThere = await h.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${SESSION_COOKIE}=${otherSession.token}` },
    })
    expect(stillThere.statusCode).toBe(200)
    await h.app.close()
  })

  test('logout-all revokes every session', async () => {
    const h = await harness()
    await addUser(h.db, 'xo', 'password1')
    const login = async () =>
      h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'xo', password: 'password1' },
      })
    const first = await login()
    const second = await login()

    const all = await h.app.inject({
      method: 'POST',
      url: '/api/auth/logout-all',
      headers: { cookie: sessionFrom(first) },
    })
    expect(all.statusCode).toBe(204)
    for (const response of [first, second]) {
      const me = await h.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: sessionFrom(response) },
      })
      expect(me.statusCode).toBe(401)
    }
    await h.app.close()
  })

  test('a password change needs the current password and replaces every session', async () => {
    const h = await harness()
    await addUser(h.db, 'xo', 'password1')
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'xo', password: 'password1' },
    })
    const headers = { cookie: sessionFrom(login) }

    const wrong = await h.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers,
      payload: { currentPassword: 'wrong-one', newPassword: 'password2' },
    })
    expect(wrong.statusCode).toBe(403)

    const changed = await h.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers,
      payload: { currentPassword: 'password1', newPassword: 'password2' },
    })
    expect(changed.statusCode).toBe(204)
    const fresh = sessionFrom(changed)

    const old = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers })
    expect(old.statusCode).toBe(401)
    const current = await h.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: fresh },
    })
    expect(current.statusCode).toBe(200)
    expect(findUserByUsername(h.db, 'xo')!.passwordHash.startsWith('$argon2id$')).toBe(true)

    const oldPassword = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'xo', password: 'password1' },
    })
    expect(oldPassword.statusCode).toBe(401)
    const newPassword = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'xo', password: 'password2' },
    })
    expect(newPassword.statusCode).toBe(200)
    await h.app.close()
  })

  test('a malformed cookie is ignored instead of throwing', async () => {
    const h = await harness()
    await addUser(h.db, 'xo', 'password1')
    for (const cookie of [
      'mv_session=%E0%A4%A',
      `mv_session=${'a'.repeat(600)}`,
      'mv_session=not-a-token',
      ';;;=',
    ]) {
      const response = await h.app.inject({ method: 'GET', url: '/api/libraries', headers: { cookie } })
      expect(response.statusCode).toBe(401)
    }
    expect(parseCookies('a=1; b=2')).toEqual({ a: '1', b: '2' })
    expect(parseCookies('a=%zz')).toEqual({ a: '%zz' })
    await h.app.close()
  })
})

describe('setup', () => {
  test('two concurrent setup requests create exactly one account', async () => {
    const h = await harness()
    const request = () =>
      h.app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { username: 'first', password: 'password1' },
      })
    const responses = await Promise.all([request(), request()])
    const codes = responses.map((response) => response.statusCode).sort()
    expect(codes).toEqual([201, 409])
    expect(h.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM users').get()!.n).toBe(1)
    await h.app.close()
  })

  test('setup is refused once an account exists', async () => {
    const h = await harness()
    await addUser(h.db, 'xo', 'password1')
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'second', password: 'password1' },
    })
    expect(response.statusCode).toBe(409)
    await h.app.close()
  })
})

describe('login rate limit', () => {
  test('ten failures lock the username for the window', async () => {
    const h = await harness()
    await addUser(h.db, 'xo', 'password1')
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'xo', password: 'wrong-one' },
      })
      expect(response.statusCode).toBe(401)
    }
    const blocked = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'xo', password: 'password1' },
    })
    expect(blocked.statusCode).toBe(429)
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
    expect(blocked.headers['cache-control']).toBe('no-store')
    await h.app.close()
  })

  test('the per-ip limit counts every attempt', () => {
    const db = openDatabase(':memory:')
    const limits = { windowMs: 60_000, maxFailuresPerUser: 10, maxAttemptsPerIp: 3 }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const admission = admitLogin(db, { username: `u${attempt}`, ip: '1.2.3.4', now: 1_000 }, limits)
      expect(admission.admitted).toBe(true)
      if (admission.admitted) finishLogin(db, admission.attemptId, 'failure')
    }
    const blocked = admitLogin(db, { username: 'u9', ip: '1.2.3.4', now: 2_000 }, limits)
    expect(blocked.admitted).toBe(false)
    if (!blocked.admitted) expect(blocked.retryAfterSeconds).toBe(59)
    expect(admitLogin(db, { username: 'u9', ip: '5.6.7.8', now: 2_000 }, limits).admitted).toBe(
      true,
    )
    db.close()
  })

  test('a forwarded header from an untrusted peer does not change the client ip', async () => {
    const h = await harness()
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': `10.0.0.${attempt + 1}` },
        payload: { username: `user${attempt}`, password: 'wrong-one' },
      })
      expect(response.statusCode).toBe(401)
    }
    const blocked = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '10.0.0.99' },
      payload: { username: 'user99', password: 'wrong-one' },
    })
    expect(blocked.statusCode).toBe(429)
    await h.app.close()
  })
})

describe('request origin', () => {
  test('a cross-origin state-changing request is refused', async () => {
    const h = await harness()
    await addUser(h.db, 'xo', 'password1')

    const foreign = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://evil.example' },
      payload: { username: 'xo', password: 'password1' },
    })
    expect(foreign.statusCode).toBe(403)

    const nullOrigin = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'null' },
      payload: { username: 'xo', password: 'password1' },
    })
    expect(nullOrigin.statusCode).toBe(403)

    const crossSite = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'sec-fetch-site': 'cross-site' },
      payload: { username: 'xo', password: 'password1' },
    })
    expect(crossSite.statusCode).toBe(403)

    const sameOrigin = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://localhost:80', 'sec-fetch-site': 'same-origin' },
      payload: { username: 'xo', password: 'password1' },
    })
    expect(sameOrigin.statusCode).toBe(200)

    const readOnly = await h.app.inject({
      method: 'GET',
      url: '/api/auth/status',
      headers: { origin: 'http://evil.example' },
    })
    expect(readOnly.statusCode).toBe(200)
    await h.app.close()
  })
})

describe('worker routes', () => {
  test('a worker route refuses a call without its token', async () => {
    const h = await harness()
    const anonymous = await h.app.inject({
      method: 'POST',
      url: '/worker/gpu/acquire',
      payload: { owner: 'w1', taskKind: 'hls' },
    })
    expect(anonymous.statusCode).toBe(401)

    const withToken = await h.app.inject({
      method: 'POST',
      url: '/worker/gpu/acquire',
      headers: { 'x-worker-token': WORKER_TOKEN },
      payload: { owner: 'w1', taskKind: 'hls' },
    })
    expect(withToken.statusCode).not.toBe(401)
    await h.app.close()
  })
})
