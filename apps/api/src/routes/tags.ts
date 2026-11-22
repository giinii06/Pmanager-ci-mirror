import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createTag, deleteTag, findTagByName, getTag, listTags, renameTag } from '@mediavault/database'
import { newId } from '@mediavault/shared'
import type { AppContext } from '../context'
import { toTagDTO, toTagSummaryDTO } from '../dto'
import { parseInput } from '../validate'

const idParams = z.object({ id: z.string().min(1).max(64) })
const kindQuery = z.object({ kind: z.enum(['video', 'image']).optional().default('video') })
const tagBody = z.object({
  name: z.string().trim().min(1, '태그 이름을 입력하세요.').max(60),
})

export function registerTagRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/tags', async (request, reply) => {
    const query = parseInput(kindQuery, request.query, reply)
    if (!query) return
    reply.send({ tags: listTags(ctx.db, query.kind).map(toTagSummaryDTO) })
  })

  app.post('/api/tags', async (request, reply) => {
    const query = parseInput(kindQuery, request.query, reply)
    if (!query) return
    const body = parseInput(tagBody, request.body, reply)
    if (!body) return
    const existing = findTagByName(ctx.db, body.name, query.kind)
    if (existing) {
      reply.code(409).send({ error: 'duplicate_tag', message: '이미 같은 이름의 태그가 있습니다.' })
      return
    }
    const created = createTag(ctx.db, newId(), body.name, Date.now(), query.kind)
    reply.code(201).send({ tag: toTagDTO(created) })
  })

  app.patch('/api/tags/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const query = parseInput(kindQuery, request.query, reply)
    if (!query) return
    const body = parseInput(tagBody, request.body, reply)
    if (!body) return
    if (!getTag(ctx.db, params.id, query.kind)) {
      reply.code(404).send({ error: 'not_found', message: 'Tag not found.' })
      return
    }
    const conflict = findTagByName(ctx.db, body.name, query.kind)
    if (conflict && conflict.id !== params.id) {
      reply.code(409).send({ error: 'duplicate_tag', message: '이미 같은 이름의 태그가 있습니다.' })
      return
    }
    const updated = renameTag(ctx.db, params.id, body.name, query.kind)
    if (!updated) {
      reply.code(404).send({ error: 'not_found', message: 'Tag not found.' })
      return
    }
    reply.send({ tag: toTagDTO(updated) })
  })

  app.delete('/api/tags/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const query = parseInput(kindQuery, request.query, reply)
    if (!query) return
    if (!deleteTag(ctx.db, params.id, query.kind)) {
      reply.code(404).send({ error: 'not_found', message: 'Tag not found.' })
      return
    }
    reply.code(204).send()
  })
}
