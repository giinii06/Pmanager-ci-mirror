import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import { findUserById } from '@mediavault/database'
import { SESSION_COOKIE, parseCookies, verifySessionToken } from './auth'
import type { AppContext } from './context'
import { registerAssetRoutes } from './routes/assets'
import { registerAuthRoutes } from './routes/auth'
import { registerIndexRoutes } from './routes/index-run'
import { registerLibraryRoutes } from './routes/libraries'
import { registerMediaRoutes } from './routes/media'
import { registerSceneRoutes } from './routes/scenes'
import { registerSystemRoutes } from './routes/system'
import { registerTagRoutes } from './routes/tags'
import { registerTranscriptionRoutes } from './routes/transcriptions'
import { registerTranslationRoutes } from './routes/translations'
import { registerWorkerAsrRoutes } from './routes/worker-asr'
import { registerWorkerEmbeddingRoutes } from './routes/worker-embedding'
import { registerWorkerGpuRoutes } from './routes/worker-gpu'
import { registerWorkerSceneRoutes } from './routes/worker-scene'
import { registerWorkerTranslationRoutes } from './routes/worker-translation'

const PUBLIC_ROUTES = new Set([
  '/api/health',
  '/api/auth/status',
  '/api/auth/setup',
  '/api/auth/login',
])

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  })

  app.decorateRequest('user', null)

  app.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0] ?? ''
    if (!pathname.startsWith('/api/') || PUBLIC_ROUTES.has(pathname)) return

    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE]
    const userId = token ? verifySessionToken(token, ctx.config.authSecret) : null
    const user = userId ? findUserById(ctx.db, userId) : null
    if (!user) {
      reply.code(401).send({ error: 'unauthorized', message: 'Sign in to continue.' })
      return reply
    }
    request.user = user
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500
    if (status >= 500) request.log.error({ err: error }, 'request failed')
    reply.code(status).send({
      error: status >= 500 ? 'internal' : (error.code ?? 'request_failed'),
      message: status >= 500 ? 'Something went wrong.' : error.message,
    })
  })

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'not_found', message: 'Route not found.' })
  })

  registerAuthRoutes(app, ctx)
  registerIndexRoutes(app, ctx)
  registerLibraryRoutes(app, ctx)
  registerAssetRoutes(app, ctx)
  registerTagRoutes(app, ctx)
  registerMediaRoutes(app, ctx)
  registerTranscriptionRoutes(app, ctx)
  registerTranslationRoutes(app, ctx)
  registerSceneRoutes(app, ctx)
  registerWorkerAsrRoutes(app, ctx)
  registerWorkerEmbeddingRoutes(app, ctx)
  registerWorkerGpuRoutes(app, ctx)
  registerWorkerSceneRoutes(app, ctx)
  registerWorkerTranslationRoutes(app, ctx)
  registerSystemRoutes(app, ctx)

  return app
}
