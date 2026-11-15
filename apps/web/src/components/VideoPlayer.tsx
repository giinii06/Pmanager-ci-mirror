import { useEffect, useRef, useState, type RefObject } from 'react'
import Hls from 'hls.js'
import { Maximize, Minimize } from 'lucide-react'
import type { AssetDTO, SubtitleTrackDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { Spinner } from './ui/Spinner'
import { SubtitleMenu, languageName, trackLabel } from './SubtitleMenu'

type HlsState = 'idle' | 'preparing' | 'ready' | 'error'

export function VideoPlayer({
  asset,
  subtitleUrl,
  tracks,
  language,
  onSelectLanguage,
  videoRef: externalRef,
  fill = false,
  startMs = null,
}: {
  asset: AssetDTO
  subtitleUrl?: string | null
  tracks: SubtitleTrackDTO[]
  language: string | null
  onSelectLanguage: (language: string | null) => void
  videoRef?: RefObject<HTMLVideoElement | null>
  /** Fills a caller-provided frame instead of sizing itself against the viewport. */
  fill?: boolean
  /** A search hit's second, which wins over the saved resume position. */
  startMs?: number | null
}) {
  const localRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = externalRef ?? localRef
  const [useHls, setUseHls] = useState(asset.playback === 'hls')
  const [hlsState, setHlsState] = useState<HlsState>(asset.playback === 'hls' ? 'preparing' : 'idle')
  const [failure, setFailure] = useState<string | null>(null)
  const [caption, setCaption] = useState<string | null>(null)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const [nativeFullscreen, setNativeFullscreen] = useState(false)
  const [captionFontSize, setCaptionFontSize] = useState(16)
  const startAt = useRef(startMs && startMs > 0 ? startMs / 1000 : 0)
  const lastSave = useRef(0)

  useEffect(() => {
    if (startMs && startMs > 0) startAt.current = startMs / 1000
  }, [startMs, asset.id])

  useEffect(() => {
    if (startMs && startMs > 0) return
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
  }, [asset.id, startMs])

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

  useEffect(() => {
    const video = videoRef.current
    if (!video || !subtitleUrl) return
    const track = video.textTracks[0]
    if (!track) return

    const sync = () => {
      track.mode = nativeFullscreen ? 'showing' : 'hidden'
      const cues = track.activeCues ? Array.from(track.activeCues) : []
      const lines = cues
        .map((cue) => (cue instanceof VTTCue ? cue.text : ''))
        .filter((line) => line !== '')
      setCaption(lines.length > 0 ? lines.join('\n') : null)
    }

    sync()
    track.addEventListener('cuechange', sync)
    track.addEventListener('load', sync)
    return () => {
      track.removeEventListener('cuechange', sync)
      track.removeEventListener('load', sync)
      setCaption(null)
    }
  }, [nativeFullscreen, subtitleUrl, videoRef])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      if (width === 0) return
      setCaptionFontSize(Math.min(64, Math.max(26, width * 0.056)))
    })
    observer.observe(video)
    return () => observer.disconnect()
  }, [videoRef])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let timer: number | null = null

    const arm = () => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        if (!video.paused) setControlsVisible(false)
      }, 2500)
    }

    const show = () => {
      setControlsVisible(true)
      arm()
    }

    const hold = () => {
      setControlsVisible(true)
      if (timer !== null) window.clearTimeout(timer)
      timer = null
    }

    const hideNow = () => {
      if (video.paused || video.seeking) return
      setControlsVisible(false)
      if (timer !== null) window.clearTimeout(timer)
      timer = null
    }

    window.addEventListener('keydown', show)
    video.addEventListener('pointermove', show)
    video.addEventListener('pointerdown', show)
    video.addEventListener('pointerleave', hideNow)
    video.addEventListener('play', show)
    video.addEventListener('seeking', show)
    video.addEventListener('pause', hold)
    return () => {
      window.removeEventListener('keydown', show)
      video.removeEventListener('pointermove', show)
      video.removeEventListener('pointerdown', show)
      video.removeEventListener('pointerleave', hideNow)
      video.removeEventListener('play', show)
      video.removeEventListener('seeking', show)
      video.removeEventListener('pause', hold)
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [videoRef])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const sync = () => {
      const element =
        document.fullscreenElement ??
        (document as Document & { webkitFullscreenElement?: Element | null })
          .webkitFullscreenElement
      setFullscreen(element !== null && element === containerRef.current)
      setNativeFullscreen(element !== null && element === video)
    }

    sync()
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  }, [videoRef])

  const toggleFullscreen = () => {
    const container = containerRef.current
    const video = videoRef.current
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
      return
    }
    if (container?.requestFullscreen) {
      void container.requestFullscreen().catch(() => undefined)
      return
    }
    // iOS has no element fullscreen, only the native player, which draws its
    // own cues and is handled by the nativeFullscreen branch.
    const legacy = video as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null
    legacy?.webkitEnterFullscreen?.()
  }

  if (failure) {
    return (
      <div
        className={cn(
          'flex flex-col items-center gap-3 text-center text-[13px] text-muted',
          fill ? 'h-full w-full justify-center px-6' : 'max-w-sm',
        )}
      >
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

  const activeTrack = language ? tracks.find((track) => track.language === language) : undefined
  const preparing = useHls && hlsState !== 'ready'

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative flex items-center justify-center',
        fill ? 'h-full w-full' : 'max-h-full max-w-full',
        fullscreen && 'h-screen w-screen bg-black',
      )}
    >
      <video
        ref={videoRef}
        controls
        controlsList="nofullscreen"
        playsInline
        poster={asset.thumbnails.medium}
        className={cn(
          'bg-black',
          fullscreen || fill
            ? 'h-full w-full object-contain'
            : 'max-h-[calc(100vh-170px)] max-w-[calc(100vw-140px)] rounded-lg shadow-2xl',
        )}
      >
        {subtitleUrl && language ? (
          <track
            key={subtitleUrl}
            kind="subtitles"
            src={subtitleUrl}
            srcLang={language}
            label={activeTrack ? trackLabel(activeTrack) : languageName(language)}
          />
        ) : null}
      </video>
      {!preparing ? (
        <div className="absolute right-2 top-2 z-20 flex items-center gap-1.5">
          <button
            type="button"
            aria-label={fullscreen ? '전체 화면 종료' : '전체 화면'}
            onClick={toggleFullscreen}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-black/55 text-white/85 backdrop-blur-sm transition-colors hover:bg-black/75 hover:text-white"
          >
            {fullscreen ? <Minimize size={13} /> : <Maximize size={13} />}
          </button>
          <SubtitleMenu tracks={tracks} language={language} onSelect={onSelectLanguage} />
        </div>
      ) : null}
      {/*
        The container is the fullscreen element, so this overlay stays in the top
        layer. The native renderer would sit under the fullscreen controls, which
        is why the offset grows with the control bar instead of using it.
      */}
      {!nativeFullscreen && caption ? (
        <div
          className="pointer-events-none absolute inset-x-0 z-10 flex justify-center px-3"
          style={{ bottom: controlsVisible ? (fullscreen ? 96 : 64) : fullscreen ? 32 : 24 }}
        >
          <span
            className="max-w-[86%] rounded-md bg-black/75 px-3 py-1.5 text-center font-medium leading-[1.4] whitespace-pre-line text-white [overflow-wrap:anywhere] [word-break:keep-all]"
            style={{ fontSize: captionFontSize }}
          >
            {caption}
          </span>
        </div>
      ) : null}
      {preparing ? (
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
