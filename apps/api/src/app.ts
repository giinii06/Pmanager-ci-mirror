import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify'
import { newId } from '@mediavault/shared'
import { SESSION_COOKIE, parseCookies, resolveSession } from './auth'
import type { AppContext } from './context'
import { diagnosticIdOf } from './observability'
import { registerAssetRoutes } from './routes/assets'
import { registerDiagnosticsRoutes } from './routes/diagnostics'
import { registerDuplicateRoutes } from './routes/duplicates'
import { registerFileOperationRoutes } from './routes/file-operations'
import { registerAuthRoutes } from './routes/auth'
import { registerJournalRoutes } from './routes/journal'
import { registerFsRoutes } from './routes/fs'
import { registerIndexRoutes } from './routes/index-run'
import { registerLibraryRoutes } from './routes/libraries'
import { registerMediaRoutes } from './routes/media'
import { registerNotificationRoutes } from './routes/notifications'
import { registerPlaybackRoutes } from './routes/playback'
import { registerSceneRoutes } from './routes/scenes'
import { registerSearchIndexRoutes } from './routes/search-index'
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
  '/api/health/live',
  '/api/health/ready',
  '/health/live',
  '/health/ready',
  '/api/auth/status',
  '/api/auth/setup',
  '/api/auth/login',
  // Always allowed so an expired session still clears its cookie.
  '/api/auth/logout',
])

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * A browser on another origin always sends `Origin` (or `Sec-Fetch-Site`) on a
 * state-changing request, so a mismatch is a cross-site attempt. Requests with
 * neither header do not come from a browser and carry no ambient cookie.
 */
function isCrossOrigin(request: FastifyRequest, allowedOrigins: string[]): boolean {
  const origin = request.headers.origin
  const site = request.headers['sec-fetch-site']
  if (origin !== undefined) {
    if (origin === 'null') return true
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      return true
    }
    if (allowedOrigins.length > 0) return !allowedOrigins.includes(parsed.origin)
    // Compare canonical origins: `new URL` drops a default port, so the raw
    // Host header must be normalized the same way.
    let expected: string
    try {
      expected = new URL(`${request.protocol}://${request.host}`).origin
    } catch {
      return true
    }
    return parsed.origin !== expected
  }
  if (typeof site === 'string') return site !== 'same-origin' && site !== 'none'
  return false
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
        censor: '[redacted]',
      },
    },
    // Server-minted: an inbound X-Request-Id is never trusted for correlation.
    genReqId: () => newId(16),
    trustProxy: ctx.config.trustProxy,
    bodyLimit: 1024 * 1024,
  })

  app.decorateRequest('user', null)
  app.decorateRequest('sessionId', null)

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'SAMEORIGIN')
    reply.header('Referrer-Policy', 'same-origin')
    reply.header('X-Request-Id', request.id)
    if (ctx.config.secureCookies && request.protocol === 'https') {
      reply.header('Strict-Transport-Security', 'max-age=31536000')
    }
    if (reply.statusCode >= 400 && typeof payload === 'string' && payload.startsWith('{')) {
      try {
        const body = JSON.parse(payload) as Record<string, unknown>
        if (body !== null && typeof body.error === 'string') {
          body.requestId = request.id
          if (reply.statusCode >= 500) body.diagnosticId = diagnosticIdOf(request.id)
          return JSON.stringify(body)
        }
      } catch {
        // A non-JSON error body passes through untouched.
      }
    }
    return payload
  })

  app.addHook('onResponse', async (request, reply) => {
    ctx.metrics?.record(
      request.method,
      request.routeOptions?.url ?? 'unmatched',
      reply.statusCode,
      reply.elapsedTime,
    )
  })

  app.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0] ?? ''
    if (!pathname.startsWith('/api/')) return

    if (!SAFE_METHODS.has(request.method) && isCrossOrigin(request, ctx.config.publicOrigins)) {
      reply
        .code(403)
        .send({ error: 'cross_origin_request', message: 'Cross-origin requests are not allowed.' })
      return reply
    }
    if (PUBLIC_ROUTES.has(pathname)) return

    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE]
    const resolved = token ? resolveSession(ctx.db, token, ctx.config.authSecret) : null
    if (!resolved) {
      reply.code(401).send({ error: 'unauthorized', message: 'Sign in to continue.' })
      return reply
    }
    request.user = resolved.user
    request.sessionId = resolved.sessionId
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500
    if (status >= 500) {
      request.log.error(
        { err: error, requestId: request.id, diagnosticId: diagnosticIdOf(request.id) },
        'request failed',
      )
    }
    reply.code(status).send({
      error: status >= 500 ? 'internal' : (error.code ?? 'request_failed'),
      message: status >= 500 ? 'Something went wrong.' : error.message,
    })
  })

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'not_found', message: 'Route not found.' })
  })

  registerAuthRoutes(app, ctx)
  registerFsRoutes(app, ctx)
  registerIndexRoutes(app, ctx)
  registerLibraryRoutes(app, ctx)
  registerAssetRoutes(app, ctx)
  registerPlaybackRoutes(app, ctx)
  registerFileOperationRoutes(app, ctx)
  registerDuplicateRoutes(app, ctx)
  registerJournalRoutes(app, ctx)
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
  registerNotificationRoutes(app, ctx)
  registerDiagnosticsRoutes(app, ctx)
  registerSearchIndexRoutes(app, ctx)
  registerSystemRoutes(app, ctx)

  return app
}
