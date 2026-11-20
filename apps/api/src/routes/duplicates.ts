import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  enqueueJob,
  findActiveJobByDedupe,
  getDuplicateGroup,
  getLibrary,
  listDuplicateGroups,
  setDuplicateGroupState,
  type DuplicateGroupCursor,
} from '@mediavault/database'
import type { AppContext } from '../context'
import { toDuplicateGroupDTO } from '../dto'
import { parseInput } from '../validate'

const idParams = z.object({ id: z.string().min(1).max(64) })

const scanBody = z.object({ libraryId: z.string().min(1).max(64).optional() })

const listQuery = z.object({
  kind: z.enum(['exact', 'similar']).default('exact'),
  state: z.enum(['open', 'kept', 'ignored', 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(200).optional(),
})

const decisionBody = z.object({ action: z.enum(['keep', 'ignore', 'delete']) })

const DELETE_MESSAGE = '중복 삭제는 파일 작업 엔진이 켜진 뒤 별도 확인을 거칩니다.'

export function registerDuplicateRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/duplicates/scans', async (request, reply) => {
    const body = parseInput(scanBody, request.body ?? {}, reply)
    if (!body) return
    if (body.libraryId && !getLibrary(ctx.db, body.libraryId)) {
      reply.code(404).send({ error: 'not_found', message: 'Library not found.' })
      return
    }

    const dedupeKey = `duplicates:${body.libraryId ?? 'all'}`
    enqueueJob(
      ctx.db,
      {
        dedupeKey,
        kind: 'maintenance',
        priority: 4,
        libraryId: body.libraryId,
        payload: { task: 'duplicates' },
        requestId: request.id,
      },
      Date.now(),
    )
    const job = findActiveJobByDedupe(ctx.db, dedupeKey)
    if (!job) throw new Error(`duplicates job ${dedupeKey} vanished right after it was queued`)
    reply.code(202).send({ jobId: job.id, dedupeKey, state: job.state })
  })

  app.get('/api/duplicates/groups', async (request, reply) => {
    const query = parseInput(listQuery, request.query, reply)
    if (!query) return

    // Similar groups need perceptual hashing, which is a documented follow-up.
    if (query.kind === 'similar') {
      reply.send({ groups: [], nextCursor: null })
      return
    }

    const cursor = query.cursor ? decodeGroupCursor(query.cursor) : null
    if (query.cursor && !cursor) {
      reply.code(400).send({ error: 'invalid_cursor', message: 'Invalid cursor.' })
      return
    }

    const page = listDuplicateGroups(ctx.db, {
      kind: query.kind,
      state: query.state,
      limit: query.limit,
      cursor,
    })
    reply.send({
      groups: page.groups.map(toDuplicateGroupDTO),
      nextCursor: page.nextCursor ? encodeGroupCursor(page.nextCursor) : null,
    })
  })

  app.get('/api/duplicates/groups/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const group = getDuplicateGroup(ctx.db, params.id)
    if (!group) {
      reply.code(404).send({ error: 'not_found', message: 'Group not found.' })
      return
    }
    reply.send(toDuplicateGroupDTO(group))
  })

  app.post('/api/duplicates/groups/:id/decisions', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const body = parseInput(decisionBody, request.body, reply)
    if (!body) return

    const group = getDuplicateGroup(ctx.db, params.id)
    if (!group) {
      reply.code(404).send({ error: 'not_found', message: 'Group not found.' })
      return
    }
    if (body.action === 'delete') {
      reply.code(409).send({ error: 'delete_not_available', message: DELETE_MESSAGE })
      return
    }

    const updated = setDuplicateGroupState(
      ctx.db,
      params.id,
      body.action === 'keep' ? 'kept' : 'ignored',
      Date.now(),
    )
    if (!updated) {
      reply.code(404).send({ error: 'not_found', message: 'Group not found.' })
      return
    }
    request.log.info({ groupId: updated.id, state: updated.state }, 'duplicate group reviewed')
    reply.send({ id: updated.id, state: updated.state })
  })
}

function encodeGroupCursor(cursor: DuplicateGroupCursor): string {
  return Buffer.from(`${cursor.createdAt}:${cursor.id}`, 'utf8').toString('base64url')
}

function decodeGroupCursor(raw: string): DuplicateGroupCursor | null {
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8')
    const separator = text.indexOf(':')
    if (separator <= 0) return null
    const createdAt = Number(text.slice(0, separator))
    const id = text.slice(separator + 1)
    if (!Number.isFinite(createdAt) || id.length === 0 || id.length > 64) return null
    return { createdAt, id }
  } catch {
    return null
  }
}
