import { create } from 'zustand'
import type { AssetDTO } from '@mediavault/shared'

interface ViewerState {
  items: AssetDTO[]
  index: number
  /** Set by a search hit so the player opens at that second. */
  startMs: number | null
  open: (items: AssetDTO[], index: number, startMs?: number | null) => void
  close: () => void
  next: () => void
  prev: () => void
  select: (asset: AssetDTO, startMs?: number | null) => void
  setFavorite: (id: string, favorite: boolean) => void
}

export const useViewer = create<ViewerState>((set) => ({
  items: [],
  index: 0,
  startMs: null,
  open: (items, index, startMs = null) => set({ items, index, startMs }),
  close: () => set({ items: [], index: 0, startMs: null }),
  next: () =>
    set((state) => ({
      index: state.items.length === 0 ? 0 : Math.min(state.items.length - 1, state.index + 1),
      startMs: null,
    })),
  prev: () => set((state) => ({ index: Math.max(0, state.index - 1), startMs: null })),
  // A related video may come from outside the gallery that opened the viewer,
  // so fall back to swapping the current slot instead of dropping the list.
  select: (asset, startMs = null) =>
    set((state) => {
      const index = state.items.findIndex((item) => item.id === asset.id)
      if (index >= 0) return { index, startMs }
      if (state.items.length === 0) return { items: [asset], index: 0, startMs }
      const items = [...state.items]
      items[state.index] = asset
      return { items, startMs }
    }),
  setFavorite: (id, favorite) =>
    set((state) => ({
      items: state.items.map((item) => (item.id === id ? { ...item, favorite } : item)),
    })),
}))
