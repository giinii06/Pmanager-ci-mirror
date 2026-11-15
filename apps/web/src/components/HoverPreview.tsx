import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type Hls from 'hls.js'
import type { AssetDTO } from '@mediavault/shared'
import { cn } from '../lib/cn'
import { useHoverPreview, type PreviewPhase } from '../store/hoverPreview'
import { useViewer } from '../store/viewer'

/**
 * Assets that just failed stay cold for a while, so moving the pointer back
 * and forth does not hammer the same broken source. Keyed by file version so a
 * re-encoded file gets a fresh chance.
 */
const failedAt = new Map<string, number>()

const cacheKeyFor = (asset: AssetDTO) => `${asset.id}:${asset.fileVersion}`

// The lightbox takes over the screen, so no tile preview may keep playing.
useViewer.subscribe((state, previous) => {
  if (state.items.length > 0 && previous.items.length === 0) {
    useHoverPreview.getState().releaseAll()
  }
})

interface HoverPreviewProps {
  delayMs?: number
  retryAfterMs?: number
}

export function HoverPreview({ delayMs = 400, retryAfterMs = 60_000 }: HoverPreviewProps) {
  const target = useHoverPreview((state) => state.target)
  const release = useHoverPreview((state) => state.release)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [phase, setPhase] = useState<PreviewPhase>({ kind: 'idle' })

  useEffect(() => {
    const stop = () => useHoverPreview.getState().releaseAll()
    window.addEventListener('scroll', stop, { capture: true, passive: true })
    window.addEventListener('resize', stop, { passive: true })
    return () => {
      window.removeEventListener('scroll', stop, true)
      window.removeEventListener('resize', stop)
    }
  }, [])

  useEffect(() => {
    if (!target) return
    const { token, asset, host } = target

    const cacheKey = cacheKeyFor(asset)
    const failedTimestamp = failedAt.get(cacheKey)
    if (failedTimestamp !== undefined) {
      if (Date.now() - failedTimestamp < retryAfterMs) {
        release(token)
        return
      }
      failedAt.delete(cacheKey)
    }

    const video = videoRef.current
    if (!video) {
      release(token)
      return
    }

    let disposed = false
    let hls: Hls | null = null
    let timer: number | null = null
    const controller = new AbortController()

    setPhase({ kind: 'arming', token })
    video.muted = true

    const fail = () => {
      if (disposed) return
      failedAt.set(cacheKey, Date.now())
      setPhase({ kind: 'unavailable', token, retryAt: Date.now() + retryAfterMs })
      release(token)
    }

    const onError = () => fail()
    video.addEventListener('error', onError)

    const start = async () => {
      if (disposed) return
      if (!host.isConnected) {
        release(token)
        return
      }
      setPhase({ kind: 'loading', token, source: asset.playback === 'hls' ? 'hls' : 'direct' })
      try {
        if (asset.playback === 'hls') {
          // A 202 on master.m3u8 would enqueue a transcode, so probe a segment
          // first: it is only served once the playlist and segments exist.
          const segmentUrl = asset.hlsUrl.replace('master.m3u8', 'seg00000.ts')
          const probe = await fetch(segmentUrl, {
            method: 'HEAD',
            cache: 'no-store',
            signal: controller.signal,
          })
          if (disposed) return
          if (probe.status !== 200) {
            fail()
            return
          }
          const { default: HlsPlayer } = await import('hls.js')
          if (disposed) return
          if (HlsPlayer.isSupported()) {
            hls = new HlsPlayer({ capLevelToPlayerSize: true })
            hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
              if (data.fatal) fail()
            })
            hls.attachMedia(video)
            hls.loadSource(asset.hlsUrl)
          } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = asset.hlsUrl
          } else {
            fail()
            return
          }
        } else {
          video.src = asset.streamUrl
        }
        await video.play()
        if (disposed) return
        setPhase({ kind: 'playing', token })
      } catch {
        if (!disposed) fail()
      }
    }

    timer = window.setTimeout(() => {
      timer = null
      void start()
    }, delayMs)

    return () => {
      disposed = true
      controller.abort()
      if (timer !== null) window.clearTimeout(timer)
      video.removeEventListener('error', onError)
      hls?.destroy()
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [delayMs, release, retryAfterMs, target])

  if (!target) return null

  const visible = phase.kind === 'playing' && phase.token === target.token

  return createPortal(
    <video
      ref={videoRef}
      muted
      playsInline
      loop
      tabIndex={-1}
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 h-full w-full scale-[1.025] object-cover transition-opacity duration-200',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    />,
    target.host,
  )
}
