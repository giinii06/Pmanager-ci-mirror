/** Pure album navigation for the non-fullscreen folder page. */
export function selectAlbumNeighbor(ids: string[], current: string, direction: 'prev' | 'next'): string | null {
  const ordered = [...new Set(ids)]
  const index = ordered.indexOf(current)
  if (index < 0 || ordered.length < 2) return null
  return ordered[(index + (direction === 'next' ? 1 : -1) + ordered.length) % ordered.length] ?? null
}

export function selectRandomAlbum(ids: string[], current: string, random = Math.random): string | null {
  const candidates = [...new Set(ids)].filter((id) => id !== current)
  if (candidates.length === 0) return null
  const value = random()
  if (!Number.isFinite(value)) return null
  const offset = Math.min(candidates.length - 1, Math.max(0, Math.floor(value * candidates.length)))
  return candidates[offset] ?? null
}
