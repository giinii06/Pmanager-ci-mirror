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
const mentionQuery = z.object({ q: z.string().max(80).default('') })
const patchBody = z.object({
  title: z.string().max(JOURNAL_TITLE_MAX).optional(),
  body: z.string().max(JOURNAL_BODY_MAX).optional(),
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
    reply.send({ items: listJournalEntries(ctx.db, request.user!.id).map(summary) })
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
    const updated = updateJournalEntry(ctx.db, request.user!.id, params.id, body, Date.now())
    if (!updated) {
      reply.code(404).send({ error: 'not_found', message: 'Journal page not found.' })
      return
    }
    reply.send(detail(updated))
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
