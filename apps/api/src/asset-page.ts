import {
  listAssets,
  resolveAssetSort,
  type AssetCursor,
  type AssetFilter,
  type AssetRecord,
  type Db,
} from '@mediavault/database'
import { decodeCursor, encodeCursor } from './cursor'

export interface AssetPage {
  records: AssetRecord[]
  total: number
  nextCursor: string | null
}

export type AssetPageResult = { kind: 'ok'; page: AssetPage } | { kind: 'invalid_cursor' }

/**
 * One page of a filtered asset list and the cursor that continues it. The gallery
 * and a smart album both page this way, so the cursor rule lives here rather than
 * in each route.
 */
export function readAssetPage(
  db: Db,
  filter: AssetFilter,
  rawCursor: string | null,
  limit: number,
): AssetPageResult {
  const cursor: AssetCursor | null = rawCursor ? decodeCursor(rawCursor) : null
  if (rawCursor && !cursor) return { kind: 'invalid_cursor' }

  const { records, total, hasMore } = listAssets(db, filter, cursor, limit)
  const sort = resolveAssetSort(filter)
  const offset = cursor && 'offset' in cursor ? cursor.offset : 0
  const last = records[records.length - 1]
  const nextCursor =
    hasMore && last
      ? sort === 'latest' && (!cursor || 'takenAt' in cursor)
        ? encodeCursor({ takenAt: last.takenAt, id: last.id })
        : encodeCursor({ offset: offset + records.length })
      : null

  return { kind: 'ok', page: { records, total, nextCursor } }
}
