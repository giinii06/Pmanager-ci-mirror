import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getAssetFileInfo } from '@mediavault/database'
import type { AppContext } from '../context'
import { ensurePipelineJobs } from '../index-trigger'
import { enqueueFaces } from '../scene-trigger'
import { parseInput } from '../validate'

const idParams = z.object({ id: z.string().min(1).max(64) })

export function registerIndexRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Runs the same pass the API's timer runs, so the UI can ask for it now. */
  app.post('/api/index/run', async (_request, reply) => {
    reply.send(ensurePipelineJobs(ctx, Date.now()))
  })

  app.post('/api/assets/:id/faces', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return

    if (!ctx.config.face.enabled) {
      reply.code(409).send({ error: 'disabled', message: 'Face recognition is not configured.' })
      return
    }
    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    if (info.kind !== 'video') {
      reply.code(422).send({ error: 'not_a_video', message: 'Only videos have faces.' })
      return
    }

    const job = enqueueFaces(ctx, info.id, info.fileVersion, Date.now())
    reply.code(202).send({ queued: job !== null, jobId: job?.id ?? null })
  })
}
