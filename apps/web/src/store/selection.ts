import { create } from 'zustand'
import type { AssetQuery } from '@mediavault/shared'

export type SelectionMode = 'ids' | 'query'

/**
 * Selection lives outside the gallery so the action bar and the dialog can
 * read it after the grid virtualizes a tile away. A query selection keeps the
 * filter instead of the rows: the server resolves it once at preview time.
 */
interface SelectionState {
  active: boolean
  mode: SelectionMode
  ids: string[]
  query: AssetQuery | null
  start: () => void
  stop: () => void
  clear: () => void
  toggle: (id: string) => void
  addMany: (ids: string[]) => void
  selectQuery: (query: AssetQuery) => void
}

export const useSelection = create<SelectionState>((set) => ({
  active: false,
  mode: 'ids',
  ids: [],
  query: null,
  start: () => set({ active: true, mode: 'ids', ids: [], query: null }),
  stop: () => set({ active: false, mode: 'ids', ids: [], query: null }),
  clear: () => set({ mode: 'ids', ids: [], query: null }),
  toggle: (id) =>
    set((state) => {
      if (state.mode === 'query') return { mode: 'ids', ids: [id], query: null }
      const ids = state.ids.includes(id)
        ? state.ids.filter((current) => current !== id)
        : [...state.ids, id]
      return { ids }
    }),
  addMany: (ids) =>
    set((state) => {
      if (state.mode === 'query') return state
      const merged = new Set(state.ids)
      for (const id of ids) merged.add(id)
      return { ids: [...merged] }
    }),
  selectQuery: (query) => set({ mode: 'query', ids: [], query }),
}))
