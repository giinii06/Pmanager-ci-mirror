import { describe, expect, test } from 'bun:test'
import type { TagSummaryDTO } from '@mediavault/shared'
import { sortTagSummaries } from './tagSort'

function tag(id: string, name: string, viewCount: number, voteCount: number, createdAt: string): TagSummaryDTO {
  return {
    id, name, viewCount, voteCount, createdAt,
    assetCount: 1, coverAssetId: null, coverPosterVersion: null,
    coverWidth: null, coverHeight: null,
  }
}
const tags = [
  tag('a', 'Banana', 18, 1, '2026-10-01T00:00:00.000Z'),
  tag('b', 'Apple', 4, 7, '2026-11-01T00:00:00.000Z'),
  tag('c', 'Cherry', 21, 3, '2026-09-01T00:00:00.000Z'),
]
const ids = (entries: readonly TagSummaryDTO[]) => entries.map((entry) => entry.id)

describe('tag overview sorting', () => {
  test('orders by total views, votes, name, and tag creation date', () => {
    expect(ids(sortTagSummaries(tags, 'views', 1))).toEqual(['c', 'a', 'b'])
    expect(ids(sortTagSummaries(tags, 'votes', 1))).toEqual(['b', 'c', 'a'])
    expect(ids(sortTagSummaries(tags, 'name', 1))).toEqual(['b', 'a', 'c'])
    expect(ids(sortTagSummaries(tags, 'date', 1))).toEqual(['b', 'a', 'c'])
    expect(ids(tags)).toEqual(['a', 'b', 'c'])
  })

  test('random order stays consistent during one overview session', () => {
    const collection = Array.from({ length: 12 }, (_, i) => tag(String(i), 'Tag'+i, 0, 0, '2026-11-01T00:00:00.000Z'))
    const first = ids(sortTagSummaries(collection, 'random', 510))
    expect(ids(sortTagSummaries(collection, 'random', 510))).toEqual(first)
    const orders = new Set([510, 511, 512, 513].map((seed) => ids(sortTagSummaries(collection, 'random', seed)).join(',')))
    expect(orders.size).toBeGreaterThan(1)
    expect(ids(collection)).toEqual(Array.from({ length: 12 }, (_, i) => String(i)))
  })

  test('empty arrays and equal-score ties have deterministic behavior', () => {
    expect(sortTagSummaries([], 'random', 12)).toEqual([])
    const tied = [tag('z','B',0,0,'2026-11-01T00:00:00.000Z'), tag('x','A',0,0,'2026-11-01T00:00:00.000Z')]
    expect(ids(sortTagSummaries(tied, 'views', 12))).toEqual(['x','z'])
  })
})
