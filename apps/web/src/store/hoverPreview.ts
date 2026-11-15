import { create } from 'zustand'
import type { AssetDTO } from '@mediavault/shared'
import { useViewer } from './viewer'

export interface PreviewTarget {
  token: symbol
  asset: AssetDTO
  host: HTMLElement
}

export type PreviewPhase =
  | { kind: 'idle' }
  | { kind: 'arming'; token: symbol }
  | { kind: 'loading'; token: symbol; source: 'direct' | 'hls' }
  | { kind: 'playing'; token: symbol }
  | { kind: 'unavailable'; token: symbol; retryAt: number }

interface HoverPreviewState {
  target: PreviewTarget | null
  /** Returns the token the caller must pass back to `release`, or null when refused. */
  request: (asset: AssetDTO, host: HTMLElement) => symbol | null
  release: (token: symbol) => void
  releaseAll: () => void
}

export const useHoverPreview = create<HoverPreviewState>((set, get) => ({
  target: null,
  request: (asset, host) => {
    if (asset.kind !== 'video' || asset.playback === 'none') return null
    if (useViewer.getState().items.length > 0) return null
    const token = Symbol(asset.id)
    set({ target: { token, asset, host } })
    return token
  },
  release: (token) => {
    if (get().target?.token === token) set({ target: null })
  },
  releaseAll: () => {
    if (get().target !== null) set({ target: null })
  },
}))
