import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  addPlaylistItem,
  createPlaylist,
  deletePlaylist,
  ensureWatchLater,
  getPlaylist,
  listPlaylistAssets,
  listPlaylistItems,
  listPlaylists,
  movePlaylistItem,
  removePlaylistItem,
  updatePlaylist,
  type PlaylistItemRecord,
  type PlaylistRecord,
  type PlaylistWriteResult,
} from '@mediavault/database'
import type { AppContext } from '../context'
import { toAssetDTO, toPlaylistDTO, toPlaylistItemDTO } from '../dto'
import { parseInput } from '../validate'

const idParams = z.object({ id: z.string().min(1).max(64) })
const itemParams = z.object({ id: z.string().min(1).max(64), itemId: z.string().min(1).max(64) })

const playlistName = z.string().trim().min(1).max(80)
const playlistDescription = z.string().trim().max(500)

const createBody = z.object({
  name: playlistName,
  description: playlistDescription.optional(),
})

const patchBody = z
  .object({
    name: playlistName.optional(),
    description: playlistDescription.nullable().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'at least one field is required',
  })

const itemBody = z.object({ assetId: z.string().min(1).max(64) })

const moveBody = z.object({ position: z.number().int().min(0).max(100_000) })

function sendNotFound(reply: FastifyReply): void {
  reply.code(404).send({ error: 'not_found', message: 'Playlist not found.' })
}

function sendWriteResult(reply: FastifyReply, result: PlaylistWriteResult, created: boolean): void {
  if (result.kind === 'missing') return sendNotFound(reply)
  if (result.kind === 'name_taken') {
    reply.code(409).send({ error: 'name_taken', message: 'You already have a playlist with that name.' })
    return
  }
  if (created) {
    reply.code(201).send(toPlaylistDTO(result.playlist))
    return
  }
  reply.send(toPlaylistDTO(result.playlist))
}

/** Answers the two ways an item write can fail. */
function sendItemFailure(
  reply: FastifyReply,
  result: { kind: 'missing' } | { kind: 'asset_missing' },
): void {
  if (result.kind === 'missing') {
    sendNotFound(reply)
    return
  }
  reply.code(404).send({ error: 'asset_not_found', message: 'Asset not found.' })
}

function sendDetail(reply: FastifyReply, playlist: PlaylistRecord, items: PlaylistItemRecord[]): void {
  reply.send({ playlist: toPlaylistDTO(playlist), items: items.map(toPlaylistItemDTO) })
}

function addItem(reply: FastifyReply, ctx: AppContext, playlistId: string, userId: string, assetId: string): void {
  const now = Date.now()
  const result = addPlaylistItem(ctx.db, { playlistId, userId, assetId, now })
  if (result.kind !== 'ok') return sendItemFailure(reply, result)
  // Re-read so the counts reflect the row just written.
  const playlist = getPlaylist(ctx.db, playlistId, userId)
  if (!playlist) return sendNotFound(reply)
  reply.code(201).send({ playlist: toPlaylistDTO(playlist), item: toPlaylistItemDTO(result.item) })
}

export function registerPlaylistRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/playlists', async (request, reply) => {
    reply.send({ playlists: listPlaylists(ctx.db, request.user!.id).map(toPlaylistDTO) })
  })

  app.post('/api/playlists', async (request, reply) => {
    const body = parseInput(createBody, request.body ?? {}, reply)
    if (!body) return
    const result = createPlaylist(ctx.db, {
      userId: request.user!.id,
      name: body.name,
      description: body.description ?? null,
      kind: 'custom',
      now: Date.now(),
    })
    sendWriteResult(reply, result, true)
  })

  // Registered before `/:id` so the literal segment is unambiguous.
  app.post('/api/playlists/watch-later', async (request, reply) => {
    const playlist = ensureWatchLater(ctx.db, request.user!.id, Date.now())
    reply.send({ playlist: toPlaylistDTO(playlist) })
  })

  app.post('/api/playlists/watch-later/items', async (request, reply) => {
    const body = parseInput(itemBody, request.body ?? {}, reply)
    if (!body) return
    const userId = request.user!.id
    const playlist = ensureWatchLater(ctx.db, userId, Date.now())
    addItem(reply, ctx, playlist.id, userId, body.assetId)
  })

  app.get('/api/playlists/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const userId = request.user!.id
    const playlist = getPlaylist(ctx.db, params.id, userId)
    if (!playlist) return sendNotFound(reply)
    sendDetail(reply, playlist, listPlaylistItems(ctx.db, params.id, userId))
  })

  app.patch('/api/playlists/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const body = parseInput(patchBody, request.body ?? {}, reply)
    if (!body) return
    const result = updatePlaylist(
      ctx.db,
      params.id,
      request.user!.id,
      { name: body.name, description: body.description },
      Date.now(),
    )
    sendWriteResult(reply, result, false)
  })

  app.delete('/api/playlists/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    if (!deletePlaylist(ctx.db, params.id, request.user!.id)) return sendNotFound(reply)
    reply.code(204).send()
  })

  app.get('/api/playlists/:id/assets', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const userId = request.user!.id
    const playlist = getPlaylist(ctx.db, params.id, userId)
    if (!playlist) return sendNotFound(reply)
    reply.send({
      playlist: toPlaylistDTO(playlist),
      items: listPlaylistAssets(ctx.db, params.id, userId).map(toAssetDTO),
    })
  })

  app.post('/api/playlists/:id/items', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const body = parseInput(itemBody, request.body ?? {}, reply)
    if (!body) return
    addItem(reply, ctx, params.id, request.user!.id, body.assetId)
  })

  app.patch('/api/playlists/:id/items/:itemId', async (request, reply) => {
    const params = parseInput(itemParams, request.params, reply)
    if (!params) return
    const body = parseInput(moveBody, request.body ?? {}, reply)
    if (!body) return
    const userId = request.user!.id
    if (!movePlaylistItem(ctx.db, params.id, params.itemId, body.position, userId)) return sendNotFound(reply)
    const playlist = getPlaylist(ctx.db, params.id, userId)
    if (!playlist) return sendNotFound(reply)
    sendDetail(reply, playlist, listPlaylistItems(ctx.db, params.id, userId))
  })

  app.delete('/api/playlists/:id/items/:itemId', async (request, reply) => {
    const params = parseInput(itemParams, request.params, reply)
    if (!params) return
    if (!removePlaylistItem(ctx.db, params.id, params.itemId, request.user!.id)) return sendNotFound(reply)
    reply.code(204).send()
  })
}
