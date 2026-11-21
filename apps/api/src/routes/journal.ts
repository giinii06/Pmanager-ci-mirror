import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  createJournalEntry,
  deleteJournalEntry,
  getJournalEntry,
  JOURNAL_BODY_MAX,
  JOURNAL_TITLE_MAX,
  listJournalEntries,
  searchJournalMentions,
  updateJournalEntry,
  type JournalEntryRecord,
  type JournalEntrySummary,
} from '@mediavault/database'
import type { JournalEntryDTO, JournalEntrySummaryDTO } from '@mediavault/shared'
import type { AppContext } from '../context'
import { parseInput } from '../validate'

const idParams = z.object({ id: z.string().min(1).max(64) })
const listQuery = z.object({
  cursor: z.string().regex(/^\d{1,16}:[0-9a-z]{12}$/).optional(),
})
const mentionQuery = z.object({ q: z.string().max(80).default('') })
const patchBody = z.object({
  title: z.string().max(JOURNAL_TITLE_MAX).optional(),
  body: z.string().max(JOURNAL_BODY_MAX).optional(),
  expectedUpdatedAt: z.string().datetime(),
}).strict().refine((value) => value.title !== undefined || value.body !== undefined, {
  message: 'title or body is required',
})

function summary(record: JournalEntrySummary): JournalEntrySummaryDTO {
  return {
    id: record.id,
    title: record.title,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
  }
}

function detail(record: JournalEntryRecord): JournalEntryDTO {
  return { ...summary(record), body: record.body }
}

export function registerJournalRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/journal', async (request, reply) => {
    const query = parseInput(listQuery, request.query, reply)
    if (!query) return
    const page = listJournalEntries(ctx.db, request.user!.id, query.cursor)
    reply.send({ items: page.items.map(summary), nextCursor: page.nextCursor })
  })

  app.post('/api/journal', async (request, reply) => {
    // The client cannot backdate or override this timestamp.
    const entry = createJournalEntry(ctx.db, request.user!.id, Date.now())
    reply.code(201).send(detail(entry))
  })

  app.get('/api/journal/mentions', async (request, reply) => {
    const query = parseInput(mentionQuery, request.query, reply)
    if (!query) return
    reply.send({ items: searchJournalMentions(ctx.db, query.q) })
  })

  app.get('/api/journal/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const entry = getJournalEntry(ctx.db, request.user!.id, params.id)
    if (!entry) {
      reply.code(404).send({ error: 'not_found', message: 'Journal page not found.' })
      return
    }
    reply.send(detail(entry))
  })

  app.patch('/api/journal/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const body = parseInput(patchBody, request.body, reply)
    if (!body) return
    const updated = updateJournalEntry(
      ctx.db,
      request.user!.id,
      params.id,
      body,
      Date.parse(body.expectedUpdatedAt),
      Date.now(),
    )
    if (updated.kind === 'missing') {
      reply.code(404).send({ error: 'not_found', message: 'Journal page not found.' })
      return
    }
    if (updated.kind === 'conflict') {
      reply.code(409).send({
        error: 'journal_conflict',
        message: 'This journal was modified in another tab or device.',
        current: detail(updated.current),
      })
      return
    }
    reply.send(detail(updated.entry))
  })

  app.delete('/api/journal/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    if (!deleteJournalEntry(ctx.db, request.user!.id, params.id)) {
      reply.code(404).send({ error: 'not_found', message: 'Journal page not found.' })
      return
    }
    reply.code(204).send()
  })
}
