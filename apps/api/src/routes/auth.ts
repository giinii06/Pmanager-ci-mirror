import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  countUsers,
  createUser,
  findUserByUsername,
  listSessions,
  recordAuthEvent,
  revokeAllSessions,
  type UserRecord,
} from '@mediavault/database'
import { newId } from '@mediavault/shared'
import {
  SESSION_COOKIE,
  clearSessionCookie,
  createSession,
  hashPassword,
  parseCookies,
  resolveSession,
  revokeSessionById,
  sessionCookie,
  spendPasswordCheck,
  verifyPassword,
} from '../auth'
import type { AppContext } from '../context'
import { toUserDTO } from '../dto'
import { admitLogin, finishLogin } from '../login-guard'
import { Semaphore } from '../semaphore'
import { parseInput } from '../validate'

const setupCredentials = z.object({
  username: z.string().trim().min(2, 'Use at least 2 characters.').max(64),
  password: z.string().min(8, 'Use at least 8 characters.').max(200),
})

// Sign-in trusts the stored hash. A password shorter than the setup minimum can
// already exist, so only an empty one is rejected here.
const loginCredentials = z.object({
  username: z.string().trim().min(2, 'Use at least 2 characters.').max(64),
  password: z.string().min(1, 'Enter your password.').max(200),
})

const passwordChange = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.').max(200),
  newPassword: z.string().min(8, 'Use at least 8 characters.').max(200),
})

const sessionParams = z.object({ id: z.string().min(1).max(64) })

const NO_STORE = { 'Cache-Control': 'no-store' }

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Two concurrent verifications are plenty for one operator and bound the CPU
  // an unauthenticated burst can consume even before the rate limit trips.
  const kdf = new Semaphore(2)

  app.get('/api/auth/status', async (request, reply) => {
    const setupRequired = countUsers(ctx.db) === 0
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE]
    const resolved = token ? resolveSession(ctx.db, token, ctx.config.authSecret) : null
    reply.headers(NO_STORE).send({
      setupRequired,
      authenticated: resolved !== null,
      user: resolved ? toUserDTO(resolved.user) : null,
    })
  })

  app.post('/api/auth/setup', async (request, reply) => {
    if (countUsers(ctx.db) > 0) {
      reply.code(409).send({ error: 'already_initialized', message: 'An account already exists.' })
      return
    }
    const body = parseInput(setupCredentials, request.body, reply)
    if (!body) return

    // Hashing stays outside the transaction; the count and insert must not race.
    const passwordHash = await hashPassword(body.password)
    const user: UserRecord = {
      id: newId(),
      username: body.username,
      passwordHash,
      createdAt: Date.now(),
    }
    const created = ctx.db
      .transaction(() => {
        if (countUsers(ctx.db) > 0) return false
        createUser(ctx.db, user)
        return true
      })
      .immediate()
    if (!created) {
      reply.code(409).send({ error: 'already_initialized', message: 'An account already exists.' })
      return
    }

    recordAuthEvent(ctx.db, {
      kind: 'setup',
      userId: user.id,
      username: user.username,
      ip: request.ip,
      createdAt: user.createdAt,
    })
    const session = createSession(ctx.db, user.id, ctx.config.authSecret, {
      userAgent: request.headers['user-agent'] ?? null,
    })
    reply
      .headers(NO_STORE)
      .header('Set-Cookie', sessionCookie(session.token, ctx.config.secureCookies))
      .code(201)
      .send({ user: toUserDTO(user) })
  })

  app.post('/api/auth/login', async (request, reply) => {
    const body = parseInput(loginCredentials, request.body, reply)
    if (!body) return

    const now = Date.now()
    const admission = admitLogin(ctx.db, { username: body.username, ip: request.ip, now })
    if (!admission.admitted) {
      recordAuthEvent(ctx.db, {
        kind: 'login_blocked',
        username: body.username,
        ip: request.ip,
        detail: `retry_after=${admission.retryAfterSeconds}`,
        createdAt: now,
      })
      reply
        .headers(NO_STORE)
        .header('Retry-After', String(admission.retryAfterSeconds))
        .code(429)
        .send({ error: 'rate_limited', message: 'Too many attempts. Try again later.' })
      return
    }

    const user = findUserByUsername(ctx.db, body.username)
    if (!user) {
      await kdf.run(() => spendPasswordCheck(body.password))
      finishLogin(ctx.db, admission.attemptId, 'failure')
      recordAuthEvent(ctx.db, {
        kind: 'login_failure',
        username: body.username,
        ip: request.ip,
        detail: 'unknown_user',
        createdAt: Date.now(),
      })
      reply
        .headers(NO_STORE)
        .code(401)
        .send({ error: 'invalid_credentials', message: 'Wrong username or password.' })
      return
    }

    const check = await kdf.run(() => verifyPassword(body.password, user.passwordHash))
    if (!check.ok) {
      finishLogin(ctx.db, admission.attemptId, 'failure')
      recordAuthEvent(ctx.db, {
        kind: 'login_failure',
        userId: user.id,
        username: user.username,
        ip: request.ip,
        createdAt: Date.now(),
      })
      reply
        .headers(NO_STORE)
        .code(401)
        .send({ error: 'invalid_credentials', message: 'Wrong username or password.' })
      return
    }

    if (check.needsRehash) {
      // Conditional so a concurrent password change cannot be overwritten.
      const rehashed = await hashPassword(body.password)
      ctx.db
        .query('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?')
        .run(rehashed, user.id, user.passwordHash)
      user.passwordHash = rehashed
    }

    finishLogin(ctx.db, admission.attemptId, 'success')
    const session = createSession(ctx.db, user.id, ctx.config.authSecret, {
      userAgent: request.headers['user-agent'] ?? null,
    })
    recordAuthEvent(ctx.db, {
      kind: 'login_success',
      userId: user.id,
      username: user.username,
      ip: request.ip,
      createdAt: Date.now(),
    })
    reply
      .headers(NO_STORE)
      .header('Set-Cookie', sessionCookie(session.token, ctx.config.secureCookies))
      .send({ user: toUserDTO(user) })
  })

  app.get('/api/auth/me', async (request, reply) => {
    const user = request.user
    if (!user) {
      reply.code(401).send({ error: 'unauthorized', message: 'Sign in to continue.' })
      return
    }
    reply.headers(NO_STORE).send({ user: toUserDTO(user) })
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE]
    const resolved = token ? resolveSession(ctx.db, token, ctx.config.authSecret) : null
    if (resolved) {
      revokeSessionById(ctx.db, resolved.sessionId)
      recordAuthEvent(ctx.db, {
        kind: 'logout',
        userId: resolved.user.id,
        username: resolved.user.username,
        ip: request.ip,
        createdAt: Date.now(),
      })
    }
    reply
      .headers(NO_STORE)
      .header('Set-Cookie', clearSessionCookie(ctx.config.secureCookies))
      .code(204)
      .send()
  })

  app.post('/api/auth/logout-all', async (request, reply) => {
    const user = request.user
    if (!user) {
      reply.code(401).send({ error: 'unauthorized', message: 'Sign in to continue.' })
      return
    }
    const revoked = revokeAllSessions(ctx.db, user.id, Date.now())
    recordAuthEvent(ctx.db, {
      kind: 'logout_all',
      userId: user.id,
      username: user.username,
      ip: request.ip,
      detail: `sessions=${revoked}`,
      createdAt: Date.now(),
    })
    reply
      .headers(NO_STORE)
      .header('Set-Cookie', clearSessionCookie(ctx.config.secureCookies))
      .code(204)
      .send()
  })

  app.get('/api/auth/sessions', async (request, reply) => {
    const user = request.user
    if (!user) {
      reply.code(401).send({ error: 'unauthorized', message: 'Sign in to continue.' })
      return
    }
    const sessions = listSessions(ctx.db, user.id, Date.now()).map((session) => ({
      id: session.id,
      createdAt: new Date(session.createdAt).toISOString(),
      lastSeenAt: new Date(session.lastSeenAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      userAgent: session.userAgent,
      current: session.id === request.sessionId,
    }))
    reply.headers(NO_STORE).send({ sessions })
  })

  app.delete('/api/auth/sessions/:id', async (request, reply) => {
    const user = request.user
    if (!user) {
      reply.code(401).send({ error: 'unauthorized', message: 'Sign in to continue.' })
      return
    }
    const params = parseInput(sessionParams, request.params, reply)
    if (!params) return
    if (!revokeSessionById(ctx.db, params.id, Date.now(), user.id)) {
      reply.code(404).send({ error: 'not_found', message: 'Session not found.' })
      return
    }
    recordAuthEvent(ctx.db, {
      kind: 'session_revoked',
      userId: user.id,
      username: user.username,
      ip: request.ip,
      detail: params.id,
      createdAt: Date.now(),
    })
    reply.code(204).send()
  })

  app.post('/api/auth/password', async (request, reply) => {
    const user = request.user
    if (!user) {
      reply.code(401).send({ error: 'unauthorized', message: 'Sign in to continue.' })
      return
    }
    const body = parseInput(passwordChange, request.body, reply)
    if (!body) return

    const check = await kdf.run(() => verifyPassword(body.currentPassword, user.passwordHash))
    if (!check.ok) {
      reply
        .headers(NO_STORE)
        .code(403)
        .send({ error: 'invalid_credentials', message: 'The current password is wrong.' })
      return
    }

    const now = Date.now()
    const passwordHash = await hashPassword(body.newPassword)
    const issued = ctx.db
      .transaction(() => {
        const updated = ctx.db
          .query('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?')
          .run(passwordHash, user.id, user.passwordHash)
        if (updated.changes !== 1) return null
        revokeAllSessions(ctx.db, user.id, now)
        return createSession(ctx.db, user.id, ctx.config.authSecret, {
          userAgent: request.headers['user-agent'] ?? null,
          now,
        })
      })
      .immediate()

    if (!issued) {
      reply
        .headers(NO_STORE)
        .code(409)
        .send({ error: 'password_changed', message: 'The password changed elsewhere. Sign in again.' })
      return
    }

    recordAuthEvent(ctx.db, {
      kind: 'password_changed',
      userId: user.id,
      username: user.username,
      ip: request.ip,
      createdAt: now,
    })
    reply
      .headers(NO_STORE)
      .header('Set-Cookie', sessionCookie(issued.token, ctx.config.secureCookies))
      .code(204)
      .send()
  })
}
