import { create } from 'zustand'
import type { AssetDTO } from '@mediavault/shared'

interface ViewerState {
  items: AssetDTO[]
  index: number
  open: (items: AssetDTO[], index: number) => void
  close: () => void
  next: () => void
  prev: () => void
  select: (asset: AssetDTO) => void
  setFavorite: (id: string, favorite: boolean) => void
}

export const useViewer = create<ViewerState>((set) => ({
  items: [],
  index: 0,
  open: (items, index) => set({ items, index }),
  close: () => set({ items: [], index: 0 }),
  next: () =>
    set((state) => ({
      index: state.items.length === 0 ? 0 : Math.min(state.items.length - 1, state.index + 1),
    })),
  prev: () => set((state) => ({ index: Math.max(0, state.index - 1) })),
  // A related video may come from outside the gallery that opened the viewer,
  // so fall back to swapping the current slot instead of dropping the list.
  select: (asset) =>
    set((state) => {
      const index = state.items.findIndex((item) => item.id === asset.id)
      if (index >= 0) return { index }
      if (state.items.length === 0) return { items: [asset], index: 0 }
      const items = [...state.items]
      items[state.index] = asset
      return { items }
    }),
  setFavorite: (id, favorite) =>
    set((state) => ({
      items: state.items.map((item) => (item.id === id ? { ...item, favorite } : item)),
    })),
}))
