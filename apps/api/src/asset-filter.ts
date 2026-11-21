import { z } from 'zod'
import type { AssetFilter } from '@mediavault/database'
import { VIDEO_SORTS } from '@mediavault/shared'

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
