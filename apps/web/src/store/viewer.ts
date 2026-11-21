import { create } from 'zustand'
import type { AssetDTO, AssetQuery } from '@mediavault/shared'
import { ApiError, api } from '../lib/api'

interface OpenViewerOptions {
  startMs?: number | null
  filter?: AssetQuery
}

type Direction = 'next' | 'prev'

interface ViewerState {
  items: AssetDTO[]
  index: number
  startMs: number | null
  shuffle: boolean
  /** Browser-contained video viewport mode; survives next/previous selections. */
  browserFill: boolean
  filter: AssetQuery | null
  sessionId: number
  navigationRequestId: number
  recentIds: string[]
  loadingNext: boolean
  open: (items: AssetDTO[], index: number, startMsOrOpts?: number | null | OpenViewerOptions) => void
  close: () => void
  toggleShuffle: () => void
  setBrowserFill: (enabled: boolean) => void
  next: () => void
  prev: () => void
  select: (asset: AssetDTO, startMs?: number | null) => void
  patchAsset: (updated: AssetDTO) => void
  removeAsset: (id: string) => void
}

type SetState = (update: (state: ViewerState) => Partial<ViewerState>) => void

const MAX_RECENT = 20
const MAX_VIEWER_ITEMS = 400
const TRIM_CHUNK = 100

let navigationController: AbortController | null = null

function cancelNavigation(): void {
  navigationController?.abort()
  navigationController = null
}

function recordRecent(recentIds: string[], id: string | undefined): string[] {
  if (!id) return recentIds
  const filtered = recentIds.filter((item) => item !== id)
  return [...filtered.slice(-(MAX_RECENT - 1)), id]
}

function neighborScope(filter: AssetQuery): AssetQuery {
  const scope: AssetQuery = {}
  if (filter.libraryId) scope.libraryId = filter.libraryId
  if (filter.folderId) scope.folderId = filter.folderId
  if (filter.kind) scope.kind = filter.kind
  if (filter.tagId) scope.tagId = filter.tagId
  if (filter.sort) scope.sort = filter.sort
  if (filter.seed !== undefined) scope.seed = filter.seed
  if (filter.q) scope.q = filter.q
  return scope
}

function randomScope(filter: AssetQuery) {
  const scope: {
    libraryId?: string
    folderId?: string
    kind?: AssetQuery['kind']
    tagId?: string
    q?: string
  } = {}
  if (filter.libraryId) scope.libraryId = filter.libraryId
  if (filter.folderId) scope.folderId = filter.folderId
  if (filter.kind) scope.kind = filter.kind
  if (filter.tagId) scope.tagId = filter.tagId
  if (filter.q) scope.q = filter.q
  return scope
}

function focusAsset(state: ViewerState, asset: AssetDTO): Partial<ViewerState> {
  const existing = state.items.findIndex((item) => item.id === asset.id)
  if (existing >= 0) {
    return {
      index: existing,
      browserFill: asset.kind === 'video' && state.browserFill,
      startMs: null,
      loadingNext: false,
      recentIds: recordRecent(state.recentIds, asset.id),
    }
  }

  let items = [...state.items, asset]
  let index = items.length - 1
  if (items.length > MAX_VIEWER_ITEMS && index >= TRIM_CHUNK) {
    items = items.slice(TRIM_CHUNK)
    index -= TRIM_CHUNK
  }
  return {
    items,
    index,
    browserFill: asset.kind === 'video' && state.browserFill,
    startMs: null,
    loadingNext: false,
    recentIds: recordRecent(state.recentIds, asset.id),
  }
}

interface NavigationRequest {
  sessionId: number
  requestId: number
  controller: AbortController
}

function startRequest(get: () => ViewerState, set: SetState): NavigationRequest | null {
  const state = get()
  if (state.loadingNext) return null
  const requestId = state.navigationRequestId + 1
  cancelNavigation()
  const controller = new AbortController()
  navigationController = controller
  set(() => ({ loadingNext: true, navigationRequestId: requestId }))
  return { sessionId: state.sessionId, requestId, controller }
}

function isCurrent(state: ViewerState, request: NavigationRequest): boolean {
  return state.sessionId === request.sessionId && state.navigationRequestId === request.requestId
}

function settle(set: SetState, request: NavigationRequest, asset: AssetDTO | null): void {
  if (navigationController === request.controller) navigationController = null
  set((state) => {
    if (!isCurrent(state, request)) return {}
    if (!asset) return { loadingNext: false }
    return focusAsset(state, asset)
  })
}

function fail(set: SetState, request: NavigationRequest, error: unknown): void {
  if (navigationController === request.controller) navigationController = null
  set((state) => {
    if (!isCurrent(state, request)) return {}
    if (error instanceof ApiError && error.status === 409) {
      return { loadingNext: false, filter: null }
    }
    return { loadingNext: false }
  })
}

async function navigateSequential(
  get: () => ViewerState,
  set: SetState,
  direction: Direction,
): Promise<void> {
  const state = get()
  const current = state.items[state.index]
  if (!current || !state.filter) return
  const request = startRequest(get, set)
  if (!request) return
  try {
    const asset = await api.neighbor(
      current.id,
      neighborScope(state.filter),
      direction,
      request.controller.signal,
    )
    settle(set, request, asset)
  } catch (error) {
    fail(set, request, error)
  }
}

async function navigateRandom(get: () => ViewerState, set: SetState): Promise<void> {
  const state = get()
  const current = state.items[state.index]

  if (!state.filter) {
    if (state.items.length <= 1) return
    const pool = state.items.filter((item) => item.id !== current?.id)
    const pick = pool[Math.floor(Math.random() * pool.length)]
    if (!pick) return
    set((s) => ({
      index: s.items.indexOf(pick),
      browserFill: pick.kind === 'video' && s.browserFill,
      startMs: null,
      navigationRequestId: s.navigationRequestId + 1,
      recentIds: recordRecent(s.recentIds, pick.id),
    }))
    return
  }

  const request = startRequest(get, set)
  if (!request) return
  try {
    const asset = await api.randomAsset(
      {
        ...randomScope(state.filter),
        currentAssetId: current?.id ?? null,
        recentIds: state.recentIds,
      },
      request.controller.signal,
    )
    settle(set, request, asset)
  } catch (error) {
    fail(set, request, error)
  }
}

export const useViewer = create<ViewerState>((set, get) => ({
  items: [],
  index: 0,
  startMs: null,
  shuffle: false,
  browserFill: false,
  filter: null,
  sessionId: 0,
  navigationRequestId: 0,
  recentIds: [],
  loadingNext: false,

  open: (items, index, startMsOrOpts = null) => {
    const opts: OpenViewerOptions =
      typeof startMsOrOpts === 'number' || startMsOrOpts === null
        ? { startMs: startMsOrOpts }
        : startMsOrOpts
    cancelNavigation()
    const currentId = items[index]?.id
    set((state) => ({
      items,
      index,
      browserFill: false,
      startMs: opts.startMs ?? null,
      filter: opts.filter ?? null,
      sessionId: state.sessionId + 1,
      navigationRequestId: state.navigationRequestId + 1,
      recentIds: currentId ? [currentId] : [],
      loadingNext: false,
    }))
  },

  close: () => {
    cancelNavigation()
    set((state) => ({
      items: [],
      index: 0,
      browserFill: false,
      startMs: null,
      filter: null,
      sessionId: state.sessionId + 1,
      navigationRequestId: state.navigationRequestId + 1,
      recentIds: [],
      loadingNext: false,
    }))
  },

  toggleShuffle: () => set((state) => ({ shuffle: !state.shuffle })),

  setBrowserFill: (enabled) => set((state) => ({
    browserFill: enabled && state.items[state.index]?.kind === 'video',
  })),

  next: () => {
    const state = get()
    if (state.shuffle) {
      void navigateRandom(get, set)
      return
    }
    if (state.index + 1 < state.items.length) {
      set((s) => ({
        index: s.index + 1,
        browserFill: s.items[s.index + 1]?.kind === 'video' && s.browserFill,
        startMs: null,
        navigationRequestId: s.navigationRequestId + 1,
        recentIds: recordRecent(s.recentIds, s.items[s.index + 1]?.id),
      }))
      return
    }
    void navigateSequential(get, set, 'next')
  },

  prev: () => {
    const state = get()
    if (state.shuffle) {
      void navigateRandom(get, set)
      return
    }
    if (state.index > 0) {
      set((s) => ({
        index: s.index - 1,
        browserFill: s.items[s.index - 1]?.kind === 'video' && s.browserFill,
        startMs: null,
        navigationRequestId: s.navigationRequestId + 1,
        recentIds: recordRecent(s.recentIds, s.items[s.index - 1]?.id),
      }))
      return
    }
    void navigateSequential(get, set, 'prev')
  },

  select: (asset, startMs = null) => {
    cancelNavigation()
    set((state) => {
      const index = state.items.findIndex((item) => item.id === asset.id)
      const navigationRequestId = state.navigationRequestId + 1
      if (index >= 0) {
        return {
          index,
          browserFill: asset.kind === 'video' && state.browserFill,
          startMs,
          navigationRequestId,
          recentIds: recordRecent(state.recentIds, asset.id),
        }
      }
      if (state.items.length === 0) {
        return { items: [asset], index: 0, browserFill: false, startMs, navigationRequestId, recentIds: [asset.id] }
      }
      const items = [...state.items]
      items[state.index] = asset
      return {
        items,
        browserFill: asset.kind === 'video' && state.browserFill,
        startMs,
        navigationRequestId,
        recentIds: recordRecent(state.recentIds, asset.id),
      }
    })
  },

  patchAsset: (updated) =>
    set((state) => ({
      items: state.items.map((item) => (item.id === updated.id ? updated : item)),
    })),

  removeAsset: (id) => {
    cancelNavigation()
    set((state) => {
      const nextItems = state.items.filter((item) => item.id !== id)
      const nextRecent = state.recentIds.filter((rid) => rid !== id)
      const navigationRequestId = state.navigationRequestId + 1
      if (nextItems.length === 0) {
        return {
          items: [],
          index: 0,
          browserFill: false,
          startMs: null,
          navigationRequestId,
          recentIds: nextRecent,
        }
      }
      const nextIndex = Math.min(state.index, nextItems.length - 1)
      return {
        items: nextItems,
        index: nextIndex,
        browserFill: nextItems[nextIndex]?.kind === 'video' && state.browserFill,
        startMs: null,
        navigationRequestId,
        recentIds: nextRecent,
      }
    })
  },
}))
