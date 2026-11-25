import { useEffect, useState } from 'react'
import {
  TIMELINE_PREVIEW_COLUMNS,
  TIMELINE_PREVIEW_FRAMES,
  TIMELINE_PREVIEW_HEIGHT,
  TIMELINE_PREVIEW_INTERVAL_SECONDS,
  TIMELINE_PREVIEW_ROWS,
  TIMELINE_PREVIEW_WIDTH,
  timelinePreviewPageCount,
  type AssetDTO,
} from '@mediavault/shared'
import { formatDuration } from '../lib/format'

function SpriteFrame({ url, cell, width }: { url: string; cell: number; width: number }) {
  const [sheetUrl, setSheetUrl] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | null = null
    let timer: number | undefined
    let attempts = 0
    const load = async () => {
      try {
        const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal })
        if (controller.signal.aborted) return
        if (response.status === 202) {
          if (++attempts < 40) timer = window.setTimeout(() => void load(), 3000)
          return
        }
        if (!response.ok) return
        const blob = await response.blob()
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setSheetUrl(objectUrl)
      } catch {
        // A missing preview must never interfere with playback.
      }
    }
    void load()
    return () => {
      controller.abort()
      if (timer !== undefined) window.clearTimeout(timer)
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [url])

  if (!sheetUrl) return null
  const height = width * TIMELINE_PREVIEW_HEIGHT / TIMELINE_PREVIEW_WIDTH
  return (
    <div
      className="rounded-sm bg-black bg-no-repeat"
      style={{
        width,
        height,
        backgroundImage: `url("${sheetUrl}")`,
        backgroundSize: `${width * TIMELINE_PREVIEW_COLUMNS}px ${height * TIMELINE_PREVIEW_ROWS}px`,
        backgroundPosition: `-${(cell % TIMELINE_PREVIEW_COLUMNS) * width}px -${Math.floor(cell / TIMELINE_PREVIEW_COLUMNS) * height}px`,
      }}
    />
  )
}

export function TimelineHoverPreview({
  asset, seconds, fraction, barWidth,
}: { asset: AssetDTO; seconds: number; fraction: number; barWidth: number }) {
  const width = Math.min(TIMELINE_PREVIEW_WIDTH, barWidth)
  const center = Math.max(width / 2, Math.min(barWidth - width / 2, fraction * barWidth))
  const pageCount = timelinePreviewPageCount(asset.durationMs)
  const frames = Math.ceil((asset.durationMs ?? 0) / (1000 * TIMELINE_PREVIEW_INTERVAL_SECONDS))
  const index = Math.max(0, Math.min(frames - 1, Math.floor(seconds / TIMELINE_PREVIEW_INTERVAL_SECONDS)))
  const page = Math.floor(index / TIMELINE_PREVIEW_FRAMES)
  const url = `/api/assets/${encodeURIComponent(asset.id)}/timeline-preview/${page}?v=${asset.fileVersion}`
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute bottom-full z-30 mb-2 flex -translate-x-1/2 flex-col items-center rounded-md bg-black/90 text-white shadow-lg"
      style={{ left: center, width }}
    >
      {pageCount > 0 ? <SpriteFrame key={url} url={url} cell={index % TIMELINE_PREVIEW_FRAMES} width={width} /> : null}
      <span className="px-2 py-1 text-xs tabular-nums">{formatDuration(seconds * 1000) || '0:00'}</span>
    </div>
  )
}
