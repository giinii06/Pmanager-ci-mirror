import { create } from 'zustand'
import type { AssetDTO, AssetQuery } from '@mediavault/shared'
import { api } from '../lib/api'

interface OpenViewerOptions {
  startMs?: number | null
  filter?: AssetQuery
}

interface ViewerState {
  items: AssetDTO[]
  index: number
  startMs: number | null
  shuffle: boolean
  poolIds: string[]
  recentIds: string[]
  loadingNext: boolean
  open: (items: AssetDTO[], index: number, startMsOrOpts?: number | null | OpenViewerOptions) => void
  close: () => void
  toggleShuffle: () => void
  next: () => void
  prev: () => void
  select: (asset: AssetDTO, startMs?: number | null) => void
  patchAsset: (updated: AssetDTO) => void
  removeAsset: (id: string) => void
}

const MAX_RECENT = 20

function recordRecent(recentIds: string[], id: string | undefined): string[] {
  if (!id) return recentIds
  const filtered = recentIds.filter((item) => item !== id)
  return [...filtered.slice(-(MAX_RECENT - 1)), id]
}

function pickRandomCandidate(pool: string[], currentId: string | undefined, recentIds: string[]): string | null {
  const withoutCurrent = pool.filter((id) => id !== currentId)
  if (withoutCurrent.length === 0) return null
  const recentSet = new Set(recentIds.slice(-Math.min(8, Math.max(1, Math.floor(withoutCurrent.length / 2)))))
  const fresh = withoutCurrent.filter((id) => !recentSet.has(id))
  const bag = fresh.length > 0 ? fresh : withoutCurrent
  return bag[Math.floor(Math.random() * bag.length)] ?? null
}

async function navigateRandom(get: () => ViewerState, set: (fn: (s: ViewerState) => Partial<ViewerState>) => void) {
  const state = get()
  if (state.loadingNext) return
  const current = state.items[state.index]
  const pool = state.poolIds.length > 1 ? state.poolIds : state.items.map((item) => item.id)
  const targetId = pickRandomCandidate(pool, current?.id, state.recentIds)
  if (!targetId) return

  const localIndex = state.items.findIndex((item) => item.id === targetId)
  if (localIndex >= 0) {
    set((s) => ({
      index: localIndex,
      startMs: null,
      recentIds: recordRecent(s.recentIds, targetId),
    }))
    return
  }

  set(() => ({ loadingNext: true }))
  try {
    const fetched = await api.asset(targetId)
    set((s) => {
      const existingIdx = s.items.findIndex((item) => item.id === fetched.id)
      if (existingIdx >= 0) {
        return {
          index: existingIdx,
          startMs: null,
          loadingNext: false,
          recentIds: recordRecent(s.recentIds, fetched.id),
        }
      }
      const nextItems = [...s.items, fetched]
      return {
        items: nextItems,
        index: nextItems.length - 1,
        startMs: null,
        loadingNext: false,
        recentIds: recordRecent(s.recentIds, fetched.id),
      }
    })
  } catch {
    set(() => ({ loadingNext: false }))
  }
}

export const useViewer = create<ViewerState>((set, get) => ({
  items: [],
  index: 0,
  startMs: null,
  shuffle: false,
  poolIds: [],
  recentIds: [],
  loadingNext: false,

  open: (items, index, startMsOrOpts = null) => {
    const opts: OpenViewerOptions =
      typeof startMsOrOpts === 'number' || startMsOrOpts === null
        ? { startMs: startMsOrOpts }
        : startMsOrOpts
    const currentId = items[index]?.id
    set({
      items,
      index,
      startMs: opts.startMs ?? null,
      poolIds: items.map((i) => i.id),
      recentIds: currentId ? [currentId] : [],
      loadingNext: false,
    })

    if (opts.filter) {
      api
        .assetIds(opts.filter)
        .then((res) => {
          if (res.ids.length === 0) return
          set((state) => (state.items.length > 0 ? { poolIds: res.ids } : state))
        })
        .catch(() => undefined)
    }
  },

  close: () =>
    set({ items: [], index: 0, startMs: null, poolIds: [], recentIds: [], loadingNext: false }),

  toggleShuffle: () => set((state) => ({ shuffle: !state.shuffle })),

  next: () => {
    const state = get()
    if (state.shuffle) {
      void navigateRandom(get, set)
      return
    }
    set((s) => {
      if (s.items.length === 0) return s
      const nextIndex = Math.min(s.items.length - 1, s.index + 1)
      return {
        index: nextIndex,
        startMs: null,
        recentIds: recordRecent(s.recentIds, s.items[nextIndex]?.id),
      }
    })
  },

  prev: () => {
    const state = get()
    if (state.shuffle) {
      void navigateRandom(get, set)
      return
    }
    set((s) => {
      const nextIndex = Math.max(0, s.index - 1)
      return {
        index: nextIndex,
        startMs: null,
        recentIds: recordRecent(s.recentIds, s.items[nextIndex]?.id),
      }
    })
  },

  select: (asset, startMs = null) =>
    set((state) => {
      const index = state.items.findIndex((item) => item.id === asset.id)
      if (index >= 0) {
        return { index, startMs, recentIds: recordRecent(state.recentIds, asset.id) }
      }
      if (state.items.length === 0) {
        return { items: [asset], index: 0, startMs, recentIds: [asset.id] }
      }
      const items = [...state.items]
      items[state.index] = asset
      return { items, startMs, recentIds: recordRecent(state.recentIds, asset.id) }
    }),

  patchAsset: (updated) =>
    set((state) => ({
      items: state.items.map((item) => (item.id === updated.id ? updated : item)),
    })),

  removeAsset: (id) =>
    set((state) => {
      const nextItems = state.items.filter((item) => item.id !== id)
      const nextPool = state.poolIds.filter((pid) => pid !== id)
      const nextRecent = state.recentIds.filter((rid) => rid !== id)
      if (nextItems.length === 0) {
        return { items: [], index: 0, startMs: null, poolIds: nextPool, recentIds: nextRecent }
      }
      const nextIndex = Math.min(state.index, nextItems.length - 1)
      return { items: nextItems, index: nextIndex, startMs: null, poolIds: nextPool, recentIds: nextRecent }
    }),
}))
