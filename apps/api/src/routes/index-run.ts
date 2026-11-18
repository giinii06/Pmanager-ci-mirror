import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context'
import { ensurePipelineJobs } from '../index-trigger'

export function registerIndexRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Runs the same pass the API's timer runs, so the UI can ask for it now. */
  app.post('/api/index/run', async (_request, reply) => {
    reply.send(ensurePipelineJobs(ctx, Date.now()))
  })
}
