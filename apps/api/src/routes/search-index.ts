import type { FastifyInstance } from 'fastify'
import type { SearchIndexGcPreviewDTO } from '@mediavault/shared'
import type { AppContext } from '../context'
import {
  RebuildInFlightError,
  gcPreview,
  gcSearchIndexBuilds,
  readSearchIndexStatus,
  rebuildSearchIndexNow,
  toSearchIndexBuildDTO,
  toSearchIndexStatusDTO,
} from '../search-index'

export function registerSearchIndexRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/system/search-index', async (_request, reply) => {
    const status = readSearchIndexStatus(ctx)
    reply.send({
      status: toSearchIndexStatusDTO(status),
      builds: status.recent.map(toSearchIndexBuildDTO),
    })
  })

  app.post('/api/system/search-index/rebuild', async (_request, reply) => {
    try {
      reply.code(201).send(toSearchIndexBuildDTO(rebuildSearchIndexNow(ctx)))
    } catch (error) {
      // Anything else is a 500 the error handler masks with a diagnostic id.
      if (!(error instanceof RebuildInFlightError)) throw error
      reply.code(409).send({
        error: 'rebuild_in_flight',
        message: 'A search index rebuild is already running.',
      })
    }
  })

  app.get('/api/system/search-index/gc/preview', async (_request, reply) => {
    const preview: SearchIndexGcPreviewDTO = gcPreview(ctx, Date.now())
    reply.send(preview)
  })

  app.post('/api/system/search-index/gc', async (_request, reply) => {
    reply.send({ deleted: gcSearchIndexBuilds(ctx, Date.now()) })
  })
}
