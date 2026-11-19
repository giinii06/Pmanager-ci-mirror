import type { FastifyReply } from 'fastify'
import { z } from 'zod'
import type { AssetFilter } from '@mediavault/database'
import { VIDEO_SORTS } from '@mediavault/shared'
import type { AppContext } from './context'
import { resolveAlbumFilter, sendAlbumFilterInvalid } from './routes/smart-albums'

/**
 * The gallery's filter, shared by the list route and a bulk preview. Keeping
 * one schema means "all results of this filter" resolves through exactly the
 * query the gallery paged through.
 */
export const assetFilterQuery = z.object({
  libraryId: z.string().max(64).optional(),
  folderId: z.string().max(64).optional(),
  kind: z.enum(['image', 'video']).optional(),
  tagId: z.string().max(64).optional(),
  sort: z.enum(VIDEO_SORTS).optional(),
  seed: z.coerce.number().int().min(0).max(2_147_483_647).optional(),
  q: z.string().max(200).optional(),
  albumId: z.string().max(64).optional(),
})

export type AssetFilterQuery = z.infer<typeof assetFilterQuery>

export function toAssetFilter(query: AssetFilterQuery): AssetFilter {
  const filter: AssetFilter = {}
  if (query.libraryId) filter.libraryId = query.libraryId
  if (query.folderId) filter.folderId = query.folderId
  if (query.kind) filter.kind = query.kind
  if (query.tagId) filter.tagId = query.tagId
  if (query.sort) filter.sort = query.sort
  if (query.seed !== undefined) filter.seed = query.seed
  if (query.q) filter.query = query.q
  return filter
}

/**
 * Adds a saved album's predicate to the filter. An explicit sort in the request
 * wins over the album's, so the same album can be browsed by another order.
 */
export function applyAlbum(
  ctx: AppContext,
  albumId: string | undefined,
  filter: AssetFilter,
  userId: string,
  reply: FastifyReply,
): boolean {
  if (!albumId) return true
  if (!ctx.config.smartAlbumsEnabled) {
    reply.code(404).send({ error: 'not_available', message: 'Smart albums are turned off.' })
    return false
  }
  const resolved = resolveAlbumFilter(ctx.db, albumId, userId)
  if (resolved.kind === 'missing') {
    reply.code(404).send({ error: 'not_found', message: 'Smart album not found.' })
    return false
  }
  if (resolved.kind === 'invalid') {
    sendAlbumFilterInvalid(reply, resolved.album)
    return false
  }
  filter.where = resolved.where
  if (!filter.sort && resolved.album.sort) filter.sort = resolved.album.sort
  return true
}
