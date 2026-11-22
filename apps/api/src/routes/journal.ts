import type { FastifyInstance } from 'fastify'
import { newId } from '@mediavault/shared'
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
import { parseJournalDocument, type JournalEntryDTO, type JournalEntrySummaryDTO } from '@mediavault/shared'
import type { AppContext } from '../context'
import { parseInput } from '../validate'

const idParams = z.object({ id: z.string().min(1).max(64) })
const imageParams = z.object({ id: z.string().min(1).max(64), imageId: z.string().regex(/^[a-z0-9_-]{12,64}$/i) })
const MAX_JOURNAL_IMAGE_BYTES = 5 * 1024 * 1024
const JOURNAL_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

function imageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6 && (bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a')) return 'image/gif'
  return null
}
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
  const document = parseJournalDocument(record.body)
  return {
    id: record.id,
    title: record.title,
    properties: document.properties,
    coverImageId: document.blocks.find((block) => block.type === 'image' && block.imageId)?.imageId ?? null,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
  }
}

function detail(record: JournalEntryRecord): JournalEntryDTO {
  return { ...summary(record), body: record.body }
}

export function registerJournalRoutes(app: FastifyInstance, ctx: AppContext): void {
  for (const mime of JOURNAL_IMAGE_TYPES) {
    app.addContentTypeParser(mime, { parseAs: 'buffer', bodyLimit: MAX_JOURNAL_IMAGE_BYTES }, (_request, body, done) => done(null, body))
  }

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

  // Same-user, same-page image uploads; never trust a filename or URL from the browser.
  app.post('/api/journal/:id/images', { bodyLimit: MAX_JOURNAL_IMAGE_BYTES }, async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    if (!getJournalEntry(ctx.db, request.user!.id, params.id)) {
      reply.code(404).send({ error: 'not_found', message: 'Journal page not found.' })
      return
    }
    const payload = request.body
    if (!Buffer.isBuffer(payload) || payload.length === 0 || payload.length > MAX_JOURNAL_IMAGE_BYTES) {
      reply.code(400).send({ error: 'invalid_image', message: 'Expected an image smaller than 5 MiB.' })
      return
    }
    const mime = imageMime(payload)
    const declared = (request.headers['content-type'] ?? '').split(';')[0]!.toLowerCase()
    if (!mime || mime !== declared) {
      reply.code(415).send({ error: 'unsupported_image', message: 'Only PNG, JPEG, WebP and GIF files are accepted.' })
      return
    }
    const id = newId()
    ctx.db.query<null, [string, string, string, string, Uint8Array, number, number]>(
      `INSERT INTO journal_images (id, entry_id, user_id, mime_type, payload, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, params.id, request.user!.id, mime, payload, payload.length, Date.now())
    reply.code(201).send({ id, url: `/api/journal/${encodeURIComponent(params.id)}/images/${id}` })
  })

  app.get('/api/journal/:id/images/:imageId', async (request, reply) => {
    const params = parseInput(imageParams, request.params, reply)
    if (!params) return
    const image = ctx.db.query<{ mimeType: string; payload: Uint8Array }, [string, string, string]>(
      `SELECT mime_type AS mimeType, payload FROM journal_images
       WHERE id = ? AND entry_id = ? AND user_id = ?`,
    ).get(params.imageId, params.id, request.user!.id)
    if (!image) {
      reply.code(404).send({ error: 'not_found', message: 'Image not found.' })
      return
    }
    reply.header('Cache-Control', 'private, no-store')
    reply.type(image.mimeType).send(Buffer.from(image.payload))
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
