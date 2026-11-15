import type { FastifyInstance } from 'fastify'
import {
  activeJobs,
  getStats,
  jobCounts,
  recentFailures,
} from '@mediavault/database'
import type { AppContext } from '../context'
import { toJobDTO } from '../dto'

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/health', async (_request, reply) => {
    reply.send({ ok: true, version: '0.1.0' })
  })

  app.get('/api/stats', async (request, reply) => {
    reply.send(getStats(ctx.db, request.user!.id))
  })

  app.get('/api/jobs', async (_request, reply) => {
    reply.send({
      counts: jobCounts(ctx.db),
      active: activeJobs(ctx.db).map(toJobDTO),
      recentFailures: recentFailures(ctx.db).map(toJobDTO),
    })
  })
}
