import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { Heart, Play } from 'lucide-react'
import type { AssetDTO } from '@mediavault/shared'
import { formatDuration } from '../lib/format'
import { cn } from '../lib/cn'
import { useHoverPreview } from '../store/hoverPreview'
import { Thumb } from './Thumb'

interface AssetTileProps {
  asset: AssetDTO
  width: number
  height: number
  onOpen: () => void
  onToggleFavorite: () => void
}

export function AssetTile({ asset, width, height, onOpen, onToggleFavorite }: AssetTileProps) {
  const duration = asset.kind === 'video' ? formatDuration(asset.durationMs) : ''
  const previewHost = useRef<HTMLDivElement>(null)
  const previewToken = useRef<symbol | null>(null)

  const stopPreview = useCallback(() => {
    const token = previewToken.current
    previewToken.current = null
    if (token !== null) useHoverPreview.getState().release(token)
  }, [])

  // A tile can be virtualized away while its preview is still playing.
  useEffect(() => stopPreview, [stopPreview])

  const beginPreview = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return
    if (asset.kind !== 'video' || asset.playback === 'none') return
    const host = previewHost.current
    if (!host) return
    stopPreview()
    previewToken.current = useHoverPreview.getState().request(asset, host)
  }

  return (
    <div
      className="group relative"
      style={{ width, height }}
      onPointerEnter={beginPreview}
      onPointerLeave={stopPreview}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={asset.filename}
        className="absolute inset-0 z-[1] rounded-tile focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
      >
        <span className="sr-only">{asset.filename}</span>
      </button>

      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-tile">
        <Thumb
          src={asset.thumbnails.medium}
          srcSet={`${asset.thumbnails.small} 320w, ${asset.thumbnails.medium} 640w`}
          sizes={`${Math.round(width)}px`}
          alt={asset.filename}
          className="h-full w-full"
          imageClassName="transition-[transform,opacity] duration-500 ease-out group-hover:scale-[1.025]"
        />
        {/* The hover preview portals into this host, below the ring, gradient and badges. */}
        <div ref={previewHost} className="pointer-events-none absolute inset-0" />
        <span className="absolute inset-0 rounded-tile ring-1 ring-inset ring-white/0 transition-colors duration-200 group-hover:ring-white/20" />
        <span className="absolute inset-0 rounded-tile bg-gradient-to-t from-black/35 via-transparent to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100" />

        {asset.kind === 'video' ? (
          <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white/90 backdrop-blur-sm">
            <Play size={10} fill="currentColor" />
            {duration || '영상'}
          </span>
        ) : null}

        <span className="absolute bottom-2 right-2 max-w-[70%] truncate rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] text-white/75 opacity-0 backdrop-blur-sm transition-opacity duration-200 group-hover:opacity-100">
          {asset.filename}
        </span>
      </div>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onToggleFavorite()
        }}
        aria-label={asset.favorite ? '즐겨찾기 해제' : '즐겨찾기'}
        className={cn(
          'absolute right-2 top-2 z-[2] rounded-full p-1.5 backdrop-blur-sm transition-all duration-150',
          asset.favorite
            ? 'bg-black/45 text-accent opacity-100'
            : 'bg-black/40 text-white/85 opacity-0 hover:text-white group-hover:opacity-100 focus-visible:opacity-100',
        )}
      >
        <Heart size={14} fill={asset.favorite ? 'currentColor' : 'none'} />
      </button>
    </div>
  )
}
