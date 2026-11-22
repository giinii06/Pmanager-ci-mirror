import type { FolderSort, TagSummaryDTO } from '@mediavault/shared'

/** Stable within one visit: changing the sort does not re-roll the tag covers. */
export function sortTagSummaries(
  tags: readonly TagSummaryDTO[],
  sort: FolderSort,
  seed: number,
): TagSummaryDTO[] {
  const sorted = [...tags]
  const byName = (a: TagSummaryDTO, b: TagSummaryDTO) =>
    a.name.localeCompare(b.name, 'ko', { sensitivity: 'base' }) || a.id.localeCompare(b.id)
  switch (sort) {
    case 'views':
      return sorted.sort((a, b) => b.viewCount - a.viewCount || byName(a, b))
    case 'votes':
      return sorted.sort((a, b) => b.voteCount - a.voteCount || byName(a, b))
    case 'name':
      return sorted.sort(byName)
    case 'date':
      return sorted.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || byName(a, b))
    case 'random': {
      // Fisher–Yates with a per-visit seed; never mutate React Query's cache.
      let state = seed >>> 0
      for (let i = sorted.length - 1; i > 0; i--) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        const j = Math.floor((state / 0x100000000) * (i + 1))
        const current = sorted[i]!
        sorted[i] = sorted[j]!
        sorted[j] = current
      }
      return sorted
    }
  }
}
