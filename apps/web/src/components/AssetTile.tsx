import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { Check, Play, ThumbsUp } from 'lucide-react'
import type { AssetDTO } from '@mediavault/shared'
import { cn } from '../lib/cn'
import { formatCount, formatDuration, formatRate } from '../lib/format'
import { useHoverPreview } from '../store/hoverPreview'
import { Thumb } from './Thumb'

interface AssetTileProps {
  asset: AssetDTO
  width: number
  height: number
  priority?: boolean
  onOpen: () => void
  onVote?: () => void
  voteDisabled?: boolean
  selectionMode?: boolean
  selected?: boolean
  onSelect?: () => void
}

export function AssetTile({
  asset,
  width,
  height,
  priority = false,
  onOpen,
  onVote,
  voteDisabled = false,
  selectionMode = false,
  selected = false,
  onSelect,
}: AssetTileProps) {
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
    if (selectionMode) return
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
        onClick={selectionMode ? onSelect : onOpen}
        aria-label={selectionMode ? `${asset.filename} 선택` : asset.filename}
        aria-pressed={selectionMode ? selected : undefined}
        className="absolute inset-0 z-[1] rounded-tile focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
      >
        <span className="sr-only">{asset.filename}</span>
      </button>

      <div
        className={cn(
          'pointer-events-none absolute inset-0 overflow-hidden rounded-tile transition-shadow',
          selected && 'ring-2 ring-inset ring-accent',
        )}
      >
        <Thumb
          src={asset.thumbnails.medium}
          srcSet={`${asset.thumbnails.small} 320w, ${asset.thumbnails.medium} 640w`}
          sizes={`${Math.round(width)}px`}
          alt={asset.filename}
          priority={priority}
          fit="contain"
          className={cn('h-full w-full transition-opacity', selected && 'opacity-80')}
          imageClassName="transition-[transform,opacity] duration-500 ease-out group-hover:scale-[1.025]"
        />
        <div ref={previewHost} className="pointer-events-none absolute inset-0" />
        <span className="absolute inset-0 rounded-tile ring-1 ring-inset ring-white/0 transition-colors duration-200 group-hover:ring-white/20" />
        <span
          className={cn(
            'absolute inset-0 rounded-tile bg-gradient-to-t from-black/50 via-transparent to-black/20 transition-opacity duration-200 group-hover:opacity-100',
            selected ? 'opacity-100' : 'opacity-0',
          )}
        />

        {asset.kind === 'video' ? (
          <>
            <span className="absolute left-2 top-2 rounded-lg bg-black/70 px-2 py-1 text-[11px] font-semibold tabular-nums text-white/95 backdrop-blur-sm">
              Rate {formatRate(asset.rate)}
            </span>
            <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded-lg bg-black/70 px-2 py-1 text-[11px] font-semibold tabular-nums text-white/95 backdrop-blur-sm">
              <Play size={10} fill="currentColor" />
              {duration || '영상'}
            </span>
          </>
        ) : null}

        <span className="absolute bottom-2 right-2 max-w-[65%] truncate rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] text-white/75 opacity-0 backdrop-blur-sm transition-opacity duration-200 group-hover:opacity-100">
          {asset.filename}
        </span>
      </div>

      {selectionMode ? (
        <span
          aria-hidden
          className={cn(
            'absolute right-2 top-2 z-[2] flex h-6 w-6 items-center justify-center rounded-full border transition-colors',
            selected
              ? 'border-accent bg-accent text-[#0b0c0f]'
              : 'border-white/60 bg-black/45 text-transparent',
          )}
        >
          <Check size={14} strokeWidth={3} />
        </span>
      ) : null}

      {!selectionMode && asset.kind === 'video' && onVote ? (
        <button
          type="button"
          disabled={voteDisabled}
          onClick={(event) => {
            event.stopPropagation()
            onVote()
          }}
          aria-label={`Vote (${formatCount(asset.voteCount)})`}
          className="absolute right-2 top-2 z-[2] inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[11px] font-medium tabular-nums text-white/90 backdrop-blur-sm transition-colors hover:bg-accent hover:text-white disabled:opacity-60"
        >
          <ThumbsUp size={11} />
          <span>{formatCount(asset.voteCount)}</span>
        </button>
      ) : null}
    </div>
  )
}
