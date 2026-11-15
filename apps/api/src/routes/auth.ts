import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  countUsers,
  createUser,
  findUserById,
  findUserByUsername,
  type UserRecord,
} from '@mediavault/database'
import { newId } from '@mediavault/shared'
import {
  SESSION_COOKIE,
  clearSessionCookie,
  createSessionToken,
  hashPassword,
  parseCookies,
  sessionCookie,
  verifyPassword,
  verifySessionToken,
} from '../auth'
import type { AppContext } from '../context'
import { toUserDTO } from '../dto'
import { parseInput } from '../validate'

const credentials = z.object({
  username: z.string().trim().min(2, 'Use at least 2 characters.').max(64),
  password: z.string().min(8, 'Use at least 8 characters.').max(200),
})

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/auth/status', async (request, reply) => {
    const setupRequired = countUsers(ctx.db) === 0
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE]
    const userId = token ? verifySessionToken(token, ctx.config.authSecret) : null
    const user = userId ? findUserById(ctx.db, userId) : null
    reply.send({
      setupRequired,
      authenticated: user !== null,
      user: user ? toUserDTO(user) : null,
    })
  })

  app.post('/api/auth/setup', async (request, reply) => {
    if (countUsers(ctx.db) > 0) {
      reply.code(409).send({ error: 'already_initialized', message: 'An account already exists.' })
      return
    }
    const body = parseInput(credentials, request.body, reply)
    if (!body) return

    const user: UserRecord = {
      id: newId(),
      username: body.username,
      passwordHash: await hashPassword(body.password),
      createdAt: Date.now(),
    }
    createUser(ctx.db, user)
    reply.header(
      'Set-Cookie',
      sessionCookie(createSessionToken(user.id, ctx.config.authSecret), ctx.config.secureCookies),
    )
    reply.code(201).send({ user: toUserDTO(user) })
  })

  app.post('/api/auth/login', async (request, reply) => {
    const body = parseInput(credentials, request.body, reply)
    if (!body) return

    const user = findUserByUsername(ctx.db, body.username)
    if (!user) {
      // Spend the same scrypt time as a real verification.
      await hashPassword(body.password)
      reply.code(401).send({ error: 'invalid_credentials', message: 'Wrong username or password.' })
      return
    }
    if (!(await verifyPassword(body.password, user.passwordHash))) {
      reply.code(401).send({ error: 'invalid_credentials', message: 'Wrong username or password.' })
      return
    }

    reply.header(
      'Set-Cookie',
      sessionCookie(createSessionToken(user.id, ctx.config.authSecret), ctx.config.secureCookies),
    )
    reply.send({ user: toUserDTO(user) })
  })

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.header('Set-Cookie', clearSessionCookie(ctx.config.secureCookies))
    reply.code(204).send()
  })

  app.get('/api/auth/me', async (request, reply) => {
    if (!request.user) {
      reply.code(401).send({ error: 'unauthorized', message: 'Sign in to continue.' })
      return
    }
    reply.send({ user: toUserDTO(request.user) })
  })
}
