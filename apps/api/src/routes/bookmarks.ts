import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  BOOKMARK_NOTE_MAX,
  BOOKMARK_TITLE_MAX,
  createBookmark,
  deleteBookmark,
  getAssetFileInfo,
  listBookmarks,
  updateBookmark,
  type BookmarkWriteResult,
} from '@mediavault/database'
import type { AppContext } from '../context'
import { toVideoBookmarkDTO } from '../dto'
import { parseInput } from '../validate'

const assetParams = z.object({ id: z.string().min(1).max(64) })
const bookmarkParams = z.object({ id: z.string().min(1).max(64) })

// The same 24 hour ceiling the playback route accepts, so a nonsense position is
// a 400 here instead of reaching the duration check.
const positionMs = z.number().int().min(0).max(86_400_000)
const bookmarkTitle = z.string().trim().max(BOOKMARK_TITLE_MAX)
const bookmarkNote = z.string().trim().max(BOOKMARK_NOTE_MAX)

const createBody = z.object({
  positionMs,
  title: bookmarkTitle.optional(),
  note: bookmarkNote.optional(),
})

const patchBody = z
  .object({
    positionMs: positionMs.optional(),
    title: bookmarkTitle.nullable().optional(),
    note: bookmarkNote.nullable().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'at least one field is required',
  })

function sendMissing(reply: FastifyReply): void {
  reply.code(404).send({ error: 'not_found', message: 'Bookmark not found.' })
}

function sendWriteResult(reply: FastifyReply, result: BookmarkWriteResult, created: boolean): void {
  switch (result.kind) {
    case 'missing':
      return sendMissing(reply)
    case 'asset_missing':
      reply.code(404).send({ error: 'asset_not_found', message: 'Asset not found.' })
      return
    case 'out_of_range':
      reply.code(422).send({
        error: 'out_of_range',
        message: 'The timestamp is outside the video.',
        details: { durationMs: result.durationMs },
      })
      return
    default:
      if (created) {
        reply.code(201).send(toVideoBookmarkDTO(result.bookmark))
        return
      }
      reply.send(toVideoBookmarkDTO(result.bookmark))
  }
}

/** A bookmark only exists against an asset the library still holds. */
function assetVisible(ctx: AppContext, assetId: string): boolean {
  const asset = getAssetFileInfo(ctx.db, assetId)
  return asset !== null && asset.deletedAt === null
}

export function registerBookmarkRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/assets/:id/bookmarks', async (request, reply) => {
    const params = parseInput(assetParams, request.params, reply)
    if (!params) return
    if (!assetVisible(ctx, params.id)) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    reply.send({ bookmarks: listBookmarks(ctx.db, request.user!.id, params.id).map(toVideoBookmarkDTO) })
  })

  app.post('/api/assets/:id/bookmarks', async (request, reply) => {
    const params = parseInput(assetParams, request.params, reply)
    if (!params) return
    const body = parseInput(createBody, request.body ?? {}, reply)
    if (!body) return
    const result = createBookmark(ctx.db, {
      userId: request.user!.id,
      assetId: params.id,
      positionMs: body.positionMs,
      title: body.title ?? null,
      note: body.note ?? null,
      now: Date.now(),
    })
    sendWriteResult(reply, result, true)
  })

  app.patch('/api/bookmarks/:id', async (request, reply) => {
    const params = parseInput(bookmarkParams, request.params, reply)
    if (!params) return
    const body = parseInput(patchBody, request.body ?? {}, reply)
    if (!body) return
    const result = updateBookmark(
      ctx.db,
      params.id,
      request.user!.id,
      { positionMs: body.positionMs, title: body.title, note: body.note },
      Date.now(),
    )
    sendWriteResult(reply, result, false)
  })

  app.delete('/api/bookmarks/:id', async (request, reply) => {
    const params = parseInput(bookmarkParams, request.params, reply)
    if (!params) return
    if (!deleteBookmark(ctx.db, params.id, request.user!.id)) return sendMissing(reply)
    reply.code(204).send()
  })
}
