import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  compileFilter,
  createSmartAlbum,
  deleteSmartAlbum,
  getSmartAlbum,
  listSmartAlbums,
  updateSmartAlbum,
  FilterCompileError,
  type CompiledFilter,
  type Db,
  type SmartAlbumPatch,
  type SmartAlbumRecord,
  type SmartAlbumWriteResult,
} from '@mediavault/database'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, VIDEO_SORTS, type FilterTree } from '@mediavault/shared'
import { readAssetPage } from '../asset-page'
import type { AppContext } from '../context'
import { toAssetDTO, toSmartAlbumDTO } from '../dto'
import { parseFilterBody } from '../filters'
import { parseInput } from '../validate'

const idParams = z.object({ id: z.string().min(1).max(64) })

const albumName = z.string().trim().min(1).max(80)
const albumDescription = z.string().trim().max(500)

const createBody = z.object({
  name: albumName,
  description: albumDescription.optional(),
  filter: z.unknown(),
  sort: z.enum(VIDEO_SORTS).nullable().optional(),
  pinned: z.boolean().optional(),
})

const patchBody = z
  .object({
    name: albumName.optional(),
    description: albumDescription.nullable().optional(),
    filter: z.unknown().optional(),
    sort: z.enum(VIDEO_SORTS).nullable().optional(),
    pinned: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'at least one field is required',
  })

const albumAssetsQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
})

export type AlbumFilterResult =
  | { kind: 'ok'; album: SmartAlbumRecord; where: CompiledFilter }
  | { kind: 'missing' }
  | { kind: 'invalid'; album: SmartAlbumRecord }

/**
 * Resolves an album the caller owns into a compiled predicate. A stored filter
 * that no longer parses or compiles is reported as invalid: answering it with a
 * broad match would show every asset under the album's name.
 */
export function resolveAlbumFilter(db: Db, albumId: string, userId: string): AlbumFilterResult {
  const album = getSmartAlbum(db, albumId, userId)
  if (!album) return { kind: 'missing' }
  if (!album.filter.valid) return { kind: 'invalid', album }
  try {
    return { kind: 'ok', album, where: compileFilter(album.filter.tree, { userId }) }
  } catch (error) {
    if (error instanceof FilterCompileError) return { kind: 'invalid', album }
    throw error
  }
}

export function sendAlbumFilterInvalid(reply: FastifyReply, album: SmartAlbumRecord): void {
  reply.code(409).send({
    error: 'album_filter_invalid',
    message: 'The saved filter can no longer be read. Edit the album and save its conditions again.',
    details: { albumId: album.id, reason: album.filter.valid ? 'compile_failed' : album.filter.error },
  })
}

function sendWriteResult(reply: FastifyReply, result: SmartAlbumWriteResult, created: boolean): void {
  if (result.kind === 'missing') {
    reply.code(404).send({ error: 'not_found', message: 'Smart album not found.' })
    return
  }
  if (result.kind === 'name_taken') {
    reply.code(409).send({ error: 'name_taken', message: 'You already have an album with that name.' })
    return
  }
  if (created) {
    reply.code(201).send(toSmartAlbumDTO(result.album))
    return
  }
  reply.send(toSmartAlbumDTO(result.album))
}

export function registerSmartAlbumRoutes(app: FastifyInstance, ctx: AppContext): void {
  const available = (reply: FastifyReply): boolean => {
    if (ctx.config.smartAlbumsEnabled) return true
    reply.code(404).send({ error: 'not_available', message: 'Smart albums are turned off.' })
    return false
  }

  app.get('/api/smart-albums', async (request, reply) => {
    if (!available(reply)) return
    reply.send({ albums: listSmartAlbums(ctx.db, request.user!.id).map(toSmartAlbumDTO) })
  })

  app.post('/api/smart-albums', async (request, reply) => {
    if (!available(reply)) return
    const body = parseInput(createBody, request.body ?? {}, reply)
    if (!body) return
    const filter = parseFilterBody(body.filter, reply)
    if (!filter) return

    const result = createSmartAlbum(ctx.db, {
      userId: request.user!.id,
      name: body.name,
      description: body.description ?? null,
      filter,
      sort: body.sort ?? null,
      pinned: body.pinned ?? false,
      now: Date.now(),
    })
    sendWriteResult(reply, result, true)
  })

  app.get('/api/smart-albums/:id', async (request, reply) => {
    if (!available(reply)) return
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const album = getSmartAlbum(ctx.db, params.id, request.user!.id)
    if (!album) {
      reply.code(404).send({ error: 'not_found', message: 'Smart album not found.' })
      return
    }
    reply.send(toSmartAlbumDTO(album))
  })

  app.patch('/api/smart-albums/:id', async (request, reply) => {
    if (!available(reply)) return
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const body = parseInput(patchBody, request.body ?? {}, reply)
    if (!body) return

    let filter: FilterTree | undefined
    if (body.filter !== undefined) {
      const parsed = parseFilterBody(body.filter, reply)
      if (!parsed) return
      filter = parsed
    }

    const patch: SmartAlbumPatch = {}
    if (body.name !== undefined) patch.name = body.name
    if (body.description !== undefined) patch.description = body.description
    if (filter !== undefined) patch.filter = filter
    if (body.sort !== undefined) patch.sort = body.sort
    if (body.pinned !== undefined) patch.pinned = body.pinned

    const result = updateSmartAlbum(ctx.db, params.id, request.user!.id, patch, Date.now())
    sendWriteResult(reply, result, false)
  })

  app.delete('/api/smart-albums/:id', async (request, reply) => {
    if (!available(reply)) return
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    if (!deleteSmartAlbum(ctx.db, params.id, request.user!.id)) {
      reply.code(404).send({ error: 'not_found', message: 'Smart album not found.' })
      return
    }
    reply.code(204).send()
  })

  app.get('/api/smart-albums/:id/assets', async (request, reply) => {
    if (!available(reply)) return
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const query = parseInput(albumAssetsQuery, request.query, reply)
    if (!query) return

    const resolved = resolveAlbumFilter(ctx.db, params.id, request.user!.id)
    if (resolved.kind === 'missing') {
      reply.code(404).send({ error: 'not_found', message: 'Smart album not found.' })
      return
    }
    if (resolved.kind === 'invalid') {
      sendAlbumFilterInvalid(reply, resolved.album)
      return
    }

    const result = readAssetPage(
      ctx.db,
      { where: resolved.where, sort: resolved.album.sort ?? undefined },
      query.cursor ?? null,
      query.limit ?? DEFAULT_PAGE_SIZE,
    )
    if (result.kind === 'invalid_cursor') {
      reply.code(400).send({ error: 'invalid_cursor', message: 'The cursor is not valid.' })
      return
    }
    reply.send({
      album: toSmartAlbumDTO(resolved.album),
      items: result.page.records.map(toAssetDTO),
      total: result.page.total,
      nextCursor: result.page.nextCursor,
    })
  })
}
