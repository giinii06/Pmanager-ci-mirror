import { create } from 'zustand'
import type { AssetDTO } from '@mediavault/shared'

interface ViewerState {
  items: AssetDTO[]
  index: number
  open: (items: AssetDTO[], index: number) => void
  close: () => void
  next: () => void
  prev: () => void
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
  setFavorite: (id, favorite) =>
    set((state) => ({
      items: state.items.map((item) => (item.id === id ? { ...item, favorite } : item)),
    })),
}))
