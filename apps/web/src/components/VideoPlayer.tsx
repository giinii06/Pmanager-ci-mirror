import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import type { AssetDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { Spinner } from './ui/Spinner'

type HlsState = 'idle' | 'preparing' | 'ready' | 'error'

export function VideoPlayer({ asset }: { asset: AssetDTO }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [useHls, setUseHls] = useState(asset.playback === 'hls')
  const [hlsState, setHlsState] = useState<HlsState>(asset.playback === 'hls' ? 'preparing' : 'idle')
  const [failure, setFailure] = useState<string | null>(null)
  const startAt = useRef(0)
  const lastSave = useRef(0)

  useEffect(() => {
    let cancelled = false
    api
      .progress(asset.id)
      .then((result) => {
        if (cancelled) return
        const progress = result.progress
        if (progress && progress.positionMs > 5000) startAt.current = progress.positionMs / 1000
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [asset.id])

  useEffect(() => {
    if (!useHls) return
    let cancelled = false
    let timer: number | null = null

    const check = async () => {
      try {
        const response = await fetch(asset.hlsUrl)
        if (cancelled) return
        if (response.status === 202) {
          setHlsState('preparing')
          timer = window.setTimeout(check, 2000)
          return
        }
        if (response.ok) {
          setHlsState('ready')
          return
        }
        setHlsState('error')
        setFailure(`재생 준비가 실패했습니다 (${response.status})`)
      } catch {
        if (!cancelled) {
          setHlsState('error')
          setFailure('재생 준비 상태를 확인하지 못했습니다.')
        }
      }
    }

    void check()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [asset.hlsUrl, useHls])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let hls: Hls | null = null
    const source = useHls ? asset.hlsUrl : asset.streamUrl
    if (useHls && hlsState !== 'ready') return

    if (useHls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, backBufferLength: 90 })
      hls.loadSource(source)
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) setFailure('영상을 재생하지 못했습니다.')
      })
    } else {
      video.src = source
    }

    return () => {
      hls?.destroy()
    }
  }, [asset.hlsUrl, asset.streamUrl, hlsState, useHls])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const restore = () => {
      if (startAt.current > 0 && Number.isFinite(video.duration)) {
        if (startAt.current < video.duration - 8) video.currentTime = startAt.current
        startAt.current = 0
      }
    }

    const save = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) return
      lastSave.current = Date.now()
      api.saveProgress(asset.id, video.currentTime * 1000, video.duration * 1000).catch(() => undefined)
    }

    const onTimeUpdate = () => {
      if (Date.now() - lastSave.current < 5000) return
      save()
    }

    const onError = () => {
      if (!useHls) {
        setUseHls(true)
        setHlsState('preparing')
      } else {
        setFailure('영상을 재생하지 못했습니다.')
      }
    }

    video.addEventListener('loadedmetadata', restore)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('pause', save)
    video.addEventListener('error', onError)
    return () => {
      video.removeEventListener('loadedmetadata', restore)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('pause', save)
      video.removeEventListener('error', onError)
      save()
    }
  }, [asset.id, useHls])

  if (failure) {
    return (
      <div className="flex max-w-sm flex-col items-center gap-3 text-center text-[13px] text-muted">
        <p className="text-ink">{failure}</p>
        <a
          href={`${asset.streamUrl}&download=1`}
          className="rounded-lg border border-line-strong px-3 py-1.5 text-ink transition-colors hover:bg-raised"
        >
          원본 내려받기
        </a>
      </div>
    )
  }

  return (
    <div className="relative flex max-h-full max-w-full items-center justify-center">
      <video
        ref={videoRef}
        controls
        playsInline
        poster={asset.thumbnails.medium}
        className="max-h-[calc(100vh-170px)] max-w-[calc(100vw-140px)] rounded-lg bg-black shadow-2xl"
      />
      {useHls && hlsState !== 'ready' ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-lg bg-black/70 text-center">
          <Spinner className="text-accent" />
          <div>
            <p className="text-[13px] font-medium text-ink">재생을 준비하고 있습니다</p>
            <p className="mt-1 text-[12px] text-muted">
              이 형식은 브라우저에서 바로 재생되지 않아 H.264로 변환합니다.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  )
}
