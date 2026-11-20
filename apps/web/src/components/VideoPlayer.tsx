import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import Hls from 'hls.js'
import { Maximize, Minimize, Pause, Play, Volume2, VolumeX } from 'lucide-react'
import type { AssetDTO, HlsStatusDTO, SubtitleTrackDTO } from '@mediavault/shared'
import { api, ApiError } from '../lib/api'
import { patchAssetCounters } from '../lib/cachePatch'
import { PlaybackReporter } from '../lib/playback'
import { StartPosition } from '../lib/start-position'
import { cn } from '../lib/cn'
import { formatDuration } from '../lib/format'
import {
  CAPTION_SCALE_KEY,
  CAPTION_SCALE_MAX,
  CAPTION_SCALE_MIN,
  CaptionSizeMenu,
  storedCaptionScale,
} from './CaptionSizeMenu'
import { Spinner } from './ui/Spinner'
import { SubtitleMenu, languageName, trackLabel } from './SubtitleMenu'

type HlsState = 'idle' | 'preparing' | 'ready' | 'error' | 'offline'

export function VideoPlayer({
  asset,
  subtitleUrl,
  tracks,
  language,
  onSelectLanguage,
  videoRef: externalRef,
  fill = false,
  startMs = null,
  onPausedChange,
}: {
  asset: AssetDTO
  subtitleUrl?: string | null
  tracks: SubtitleTrackDTO[]
  language: string | null
  onSelectLanguage: (language: string | null) => void
  videoRef?: RefObject<HTMLVideoElement | null>
  /** Fills a caller-provided frame instead of sizing itself against the viewport. */
  fill?: boolean
  /** Optional explicit timestamp from a search hit or bookmark. Normal opens start at 0. */
  startMs?: number | null
  onPausedChange?: (paused: boolean) => void
}) {
  const queryClient = useQueryClient()
  const localRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLTrackElement>(null)
  const videoRef = externalRef ?? localRef
  const [useHls, setUseHls] = useState(asset.playback === 'hls')
  const [hlsState, setHlsState] = useState<HlsState>(asset.playback === 'hls' ? 'preparing' : 'idle')
  const [playlistUrl, setPlaylistUrl] = useState<string | null>(null)
  const [hlsProgress, setHlsProgress] = useState<number | null>(null)
  const [retryToken, setRetryToken] = useState(0)
  const [retrying, setRetrying] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [captionLines, setCaptionLines] = useState<string[] | null>(null)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [containerFullscreen, setContainerFullscreen] = useState(false)
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false)
  const [nativeFullscreen, setNativeFullscreen] = useState(false)
  const [playbackPaused, setPlaybackPaused] = useState(true)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [bufferedEnd, setBufferedEnd] = useState(0)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [captionFontSize, setCaptionFontSize] = useState(16)
  const [captionScale, setCaptionScale] = useState(storedCaptionScale)
  // Only an explicitly requested timestamp can move the initial playhead.
  // Recorded playback progress is never fetched or applied on a new open.
  const [startPosition] = useState(() => new StartPosition(startMs))
  // Direct-to-HLS fallback retains the position within the SAME playback session.
  const carryOver = useRef(0)
  const reporterRef = useRef<PlaybackReporter | null>(null)
  const appFullscreen = containerFullscreen || pseudoFullscreen

  const changeCaptionScale = (value: number) => {
    const next =
      Math.round(Math.min(CAPTION_SCALE_MAX, Math.max(CAPTION_SCALE_MIN, value)) * 100) / 100
    setCaptionScale(next)
    try {
      localStorage.setItem(CAPTION_SCALE_KEY, String(next))
    } catch {
      // A blocked storage only costs the preference on the next visit.
    }
  }

  const applyStartPosition = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    // Take an explicit timestamp at most once, after the media duration is known.
    const positionMs = startPosition.take(video.duration * 1000)
    if (positionMs !== null) video.currentTime = positionMs / 1000
  }, [startPosition, videoRef])

  useEffect(() => {
    if (startMs !== null && startMs > 0) {
      startPosition.override(startMs)
      applyStartPosition()
    }
  }, [applyStartPosition, startMs, startPosition])

  useEffect(() => {
    if (!useHls) return
    const controller = new AbortController()
    let timer: number | null = null
    let attempts = 0

    const schedule = () => {
      if (controller.signal.aborted) return
      // 2s, 4s, 8s, 16s, then a 30s ceiling: an encode of a long file must not
      // turn into a request every two seconds for an hour.
      const delay = Math.min(2000 * 2 ** Math.min(attempts, 4), 30_000)
      attempts += 1
      timer = window.setTimeout(() => void check(), delay)
    }

    const check = async () => {
      timer = null
      try {
        const response = await fetch(asset.hlsStatusUrl, {
          signal: controller.signal,
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        })
        if (controller.signal.aborted) return
        const body = (await response.json().catch(() => null)) as HlsStatusDTO | null

        if (body?.state === 'source_offline' || response.status === 503) {
          setHlsState('offline')
          return
        }
        if (body?.state === 'ready' && body.playlistUrl) {
          setPlaylistUrl(body.playlistUrl)
          setHlsProgress(100)
          setHlsState('ready')
          return
        }
        if (body?.state === 'failed' || body?.state === 'cancelled') {
          setHlsState('error')
          setFailure(body.message ?? null)
          return
        }
        if (!response.ok && response.status !== 202) {
          setHlsState('error')
          setFailure(`재생 준비가 실패했습니다 (${response.status})`)
          return
        }

        if (typeof body?.progressPercent === 'number') setHlsProgress(body.progressPercent)
        setHlsState('preparing')
        schedule()
      } catch {
        if (controller.signal.aborted) return
        setHlsState('error')
        setFailure('재생 준비 상태를 확인하지 못했습니다.')
      }
    }

    void check()
    return () => {
      controller.abort()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [asset.hlsStatusUrl, retryToken, useHls])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let lastProgressSave = 0

    const onLoadedMetadata = () => {
      const positionMs = startPosition.take(video.duration * 1000)
      if (positionMs !== null) {
        video.currentTime = positionMs / 1000
        return
      }
      // The explicit timestamp must wait for usable duration metadata.
      if (startPosition.current === 'ready') return
      // A replacement source (direct to HLS) resumes where the old one was.
      if (carryOver.current > 0) {
        const seconds = carryOver.current
        carryOver.current = 0
        if (Number.isFinite(video.duration) && seconds < video.duration - 1) {
          video.currentTime = seconds
        }
        startPosition.userSeek()
      }
    }

    const saveProgress = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) return
      lastProgressSave = Date.now()
      reporterRef.current?.progress(video.currentTime * 1000, video.duration * 1000)
    }

    const onTimeUpdate = () => {
      if (Date.now() - lastProgressSave < 5000) return
      saveProgress()
    }

    const onSeeking = () => {
      startPosition.userSeek()
    }

    const onError = () => {
      if (!useHls) {
        carryOver.current = Number.isFinite(video.currentTime) ? video.currentTime : 0
        setUseHls(true)
        setHlsState('preparing')
      } else {
        setFailure('영상을 재생하지 못했습니다.')
      }
    }

    video.addEventListener('loadedmetadata', onLoadedMetadata)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('pause', saveProgress)
    video.addEventListener('seeking', onSeeking)
    video.addEventListener('error', onError)
    return () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('pause', saveProgress)
      video.removeEventListener('seeking', onSeeking)
      video.removeEventListener('error', onError)
      saveProgress()
    }
  }, [asset.id, startPosition, retryToken, useHls])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (useHls && (hlsState !== 'ready' || !playlistUrl)) return
    const source = useHls ? playlistUrl : asset.streamUrl
    if (!source) return

    let hls: Hls | null = null
    // Recovery is bounded per mount: a stream that keeps failing must surface
    // the retry button instead of reloading forever.
    let networkRetries = 0
    let mediaRetries = 0

    if (useHls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, backBufferLength: 90 })
      hls.loadSource(source)
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 3) {
          networkRetries += 1
          hls?.startLoad()
          return
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries < 2) {
          mediaRetries += 1
          hls?.recoverMediaError()
          return
        }
        setFailure('영상을 재생하지 못했습니다.')
      })
    } else {
      video.src = source
    }

    return () => {
      hls?.destroy()
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [asset.streamUrl, hlsState, playlistUrl, useHls])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let activeSince: number | null = null
    let pendingMs = 0

    const commitElapsed = () => {
      if (activeSince === null) return
      const now = performance.now()
      const delta = now - activeSince
      activeSince = null
      if (delta > 0 && Number.isFinite(delta)) pendingMs += delta
    }

    const resumeTicking = () => {
      if (!video.paused && !video.seeking && video.readyState >= 3) {
        activeSince = performance.now()
      }
    }

    const flush = (keepalive: boolean) => {
      commitElapsed()
      const deltaMs = Math.round(pendingMs)
      if (deltaMs >= 250) {
        // The reporter owns the outbox; it coalesces this delta and retries
        // with the same event id if the request fails.
        pendingMs = 0
        reporterRef.current?.watchTime(deltaMs)
      }
      if (keepalive) reporterRef.current?.flush(true)
      resumeTicking()
    }

    const onPlaying = () => {
      onPausedChange?.(false)
      if (activeSince === null) activeSince = performance.now()
      reporterRef.current?.view()
    }

    const onPauseOrEnd = () => {
      onPausedChange?.(true)
      flush(false)
      if (Number.isFinite(video.duration) && video.duration > 0) {
        reporterRef.current?.progress(video.currentTime * 1000, video.duration * 1000)
      }
    }

    const onStopTicking = () => {
      commitElapsed()
    }

    const onPlay = () => {
      onPausedChange?.(false)
    }

    const onPageHide = () => flush(true)

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush(true)
      else resumeTicking()
    }

    onPausedChange?.(video.paused)
    const timer = window.setInterval(() => {
      if (activeSince !== null && performance.now() - activeSince >= 4_000) {
        flush(false)
      }
    }, 2_000)

    video.addEventListener('playing', onPlaying)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPauseOrEnd)
    video.addEventListener('ended', onPauseOrEnd)
    video.addEventListener('waiting', onStopTicking)
    video.addEventListener('seeking', onStopTicking)
    video.addEventListener('stalled', onStopTicking)
    window.addEventListener('pagehide', onPageHide)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.clearInterval(timer)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPauseOrEnd)
      video.removeEventListener('ended', onPauseOrEnd)
      video.removeEventListener('waiting', onStopTicking)
      video.removeEventListener('seeking', onStopTicking)
      video.removeEventListener('stalled', onStopTicking)
      window.removeEventListener('pagehide', onPageHide)
      document.removeEventListener('visibilitychange', onVisibility)
      flush(true)
    }
  }, [asset.id, onPausedChange, retryToken, videoRef])

  // Declared after the accounting effect so its cleanup (which flushes the last
  // few seconds) runs before the reporter is disposed.
  useEffect(() => {
    const reporter = new PlaybackReporter({
      assetId: asset.id,
      fileVersion: asset.fileVersion,
      onCounters: (counters) => patchAssetCounters(queryClient, asset.id, counters),
    })
    reporterRef.current = reporter
    return () => {
      reporter.dispose()
      if (reporterRef.current === reporter) reporterRef.current = null
    }
  }, [asset.fileVersion, asset.id, queryClient])

  useEffect(() => {
    const element = trackRef.current
    const track = element?.track
    if (!element || !track) return

    const sync = () => {
      // Native fullscreen is the one surface where a DOM overlay cannot follow
      // the video, so the browser draws the cues there instead.
      track.mode = nativeFullscreen ? 'showing' : 'hidden'
      const cues = track.activeCues ? Array.from(track.activeCues) : []
      // A translation track carries the spoken line and its translation as two
      // lines of one cue, so each line is kept separate for styling.
      const lines = cues
        .flatMap((cue) => (cue instanceof VTTCue ? cue.text.split('\n') : []))
        .map((line) => line.trim())
        .filter((line) => line !== '')
      setCaptionLines(lines.length > 0 ? lines : null)
    }

    sync()
    track.addEventListener('cuechange', sync)
    // `load` belongs to the element; the TextTrack itself only emits cuechange.
    element.addEventListener('load', sync)
    return () => {
      track.removeEventListener('cuechange', sync)
      element.removeEventListener('load', sync)
      setCaptionLines(null)
    }
  }, [nativeFullscreen, subtitleUrl])

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
    const container = containerRef.current
    if (!video) return
    let timer: number | null = null

    const syncTimeline = () => {
      setPlaybackPaused(video.paused)
      setCurrentTime(Number.isFinite(video.currentTime) ? video.currentTime : 0)
      setDuration(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0)
      setMuted(video.muted)
      setVolume(video.volume)
      if (video.buffered.length > 0) {
        setBufferedEnd(video.buffered.end(video.buffered.length - 1))
      }
    }

    const arm = () => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        if (!video.paused) setControlsVisible(false)
      }, 2500)
    }

    const show = () => {
      syncTimeline()
      setControlsVisible(true)
      arm()
    }

    const hold = () => {
      syncTimeline()
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

    syncTimeline()
    window.addEventListener('keydown', show)
    container?.addEventListener('pointermove', show)
    container?.addEventListener('pointerdown', show)
    container?.addEventListener('pointerleave', hideNow)
    video.addEventListener('loadedmetadata', syncTimeline)
    video.addEventListener('durationchange', syncTimeline)
    video.addEventListener('timeupdate', syncTimeline)
    video.addEventListener('progress', syncTimeline)
    video.addEventListener('volumechange', syncTimeline)
    video.addEventListener('play', show)
    video.addEventListener('seeking', show)
    video.addEventListener('pause', hold)
    video.addEventListener('ended', hold)
    return () => {
      window.removeEventListener('keydown', show)
      container?.removeEventListener('pointermove', show)
      container?.removeEventListener('pointerdown', show)
      container?.removeEventListener('pointerleave', hideNow)
      video.removeEventListener('loadedmetadata', syncTimeline)
      video.removeEventListener('durationchange', syncTimeline)
      video.removeEventListener('timeupdate', syncTimeline)
      video.removeEventListener('progress', syncTimeline)
      video.removeEventListener('volumechange', syncTimeline)
      video.removeEventListener('play', show)
      video.removeEventListener('seeking', show)
      video.removeEventListener('pause', hold)
      video.removeEventListener('ended', hold)
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
      setContainerFullscreen(element !== null && element === containerRef.current)
      setNativeFullscreen(element !== null && element === video)
    }

    // iPhone Safari does not expose native video fullscreen through the
    // document, so the video's own events are the only signal there.
    const enterNative = () => setNativeFullscreen(true)
    const leaveNative = () => setNativeFullscreen(false)

    sync()
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    video.addEventListener('webkitbeginfullscreen', enterNative)
    video.addEventListener('webkitendfullscreen', leaveNative)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
      video.removeEventListener('webkitbeginfullscreen', enterNative)
      video.removeEventListener('webkitendfullscreen', leaveNative)
    }
  }, [videoRef])

  useEffect(() => {
    if (!pseudoFullscreen) return

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Escape leaves the app's fullscreen before the viewer sees it close.
      event.stopImmediatePropagation()
      setPseudoFullscreen(false)
    }
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = overflow
    }
  }, [pseudoFullscreen])

  const toggleFullscreen = () => {
    const container = containerRef.current
    const fsDoc = document as Document & {
      webkitFullscreenElement?: Element | null
      webkitExitFullscreen?: () => Promise<void> | void
    }
    if (document.fullscreenElement || fsDoc.webkitFullscreenElement) {
      if (document.exitFullscreen) void document.exitFullscreen().catch(() => undefined)
      else void fsDoc.webkitExitFullscreen?.()
      return
    }
    if (pseudoFullscreen) {
      setPseudoFullscreen(false)
      return
    }
    if (container?.requestFullscreen) {
      // A rejected request still leaves the viewer in the app's own fullscreen
      // rather than falling through to the native player.
      void container.requestFullscreen().catch(() => setPseudoFullscreen(true))
      return
    }
    // iPhone Safari has no element fullscreen, so the app draws its own frame.
    setPseudoFullscreen(true)
  }

  const retryPlayback = async () => {
    if (retrying) return
    setRetrying(true)
    try {
      // An offline library needs no new job, only a fresh status check; the
      // request would just be refused with the same 503.
      if (hlsState !== 'offline') await api.retryHls(asset.id)
      setFailure(null)
      setPlaylistUrl(null)
      setHlsProgress(null)
      setHlsState('preparing')
      setRetryToken((value) => value + 1)
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) {
        setFailure(null)
        setHlsState('offline')
        return
      }
      setFailure(error instanceof ApiError ? error.message : '다시 시도하지 못했습니다.')
    } finally {
      setRetrying(false)
    }
  }

  const offline = hlsState === 'offline'
  if (failure || hlsState === 'error' || offline) {
    return (
      <div
        className={cn(
          'flex flex-col items-center gap-3 text-center text-[13px] text-white/75',
          fill ? 'h-full w-full justify-center px-6' : 'max-w-sm',
        )}
      >
        <p className="text-white">
          {failure ??
            (offline ? '원본이 있는 라이브러리가 오프라인입니다.' : '영상을 재생하지 못했습니다.')}
        </p>
        {offline ? <p>라이브러리가 다시 연결되면 이어서 재생할 수 있습니다.</p> : null}
        <div className="flex flex-wrap items-center justify-center gap-2">
          {useHls ? (
            <button
              type="button"
              onClick={() => void retryPlayback()}
              disabled={retrying}
              className="rounded-lg border border-white/25 px-3 py-1.5 text-white transition-colors hover:bg-white/10 disabled:opacity-60"
            >
              {retrying ? '다시 시도 중…' : offline ? '다시 확인' : '다시 시도'}
            </button>
          ) : null}
          <a
            href={`${asset.streamUrl}&download=1`}
            className="rounded-lg border border-white/25 px-3 py-1.5 text-white transition-colors hover:bg-white/10"
          >
            원본 내려받기
          </a>
        </div>
      </div>
    )
  }

  const activeTrack = language ? tracks.find((track) => track.language === language) : undefined
  const sourceLanguage = tracks.find((track) => track.source === 'asr')?.language ?? null
  // A translation track is served with the spoken line above it.
  const dual = activeTrack?.source === 'translation'
  const preparing = useHls && hlsState !== 'ready'
  const showBar = !preparing && (controlsVisible || playbackPaused)
  const playedPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0
  const bufferedPct = duration > 0 ? Math.min(100, (bufferedEnd / duration) * 100) : 0

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play().catch(() => undefined)
    else video.pause()
  }

  const toggleMute = () => {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
  }

  const handleSeek = (nextSec: number) => {
    const video = videoRef.current
    if (!video || !Number.isFinite(nextSec)) return
    video.currentTime = nextSec
    setCurrentTime(nextSec)
  }

  const handleVolume = (nextVol: number) => {
    const video = videoRef.current
    if (!video) return
    video.volume = nextVol
    video.muted = nextVol === 0
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative flex items-center justify-center select-none',
        fill ? 'h-full w-full' : 'max-h-full max-w-full',
        appFullscreen &&
          (pseudoFullscreen
            ? 'fixed inset-0 z-[80] h-[100dvh] w-screen bg-black'
            : 'h-screen w-screen bg-black'),
      )}
    >
      <video
        ref={videoRef}
        playsInline
        poster={asset.thumbnails.medium}
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
        className={cn(
          'cursor-pointer bg-black',
          appFullscreen || fill
            ? 'h-full w-full object-contain'
            : 'max-h-[calc(100vh-170px)] max-w-[calc(100vw-140px)] rounded-lg shadow-2xl',
        )}
      >
        {subtitleUrl && language ? (
          <track
            ref={trackRef}
            key={subtitleUrl}
            kind="subtitles"
            src={subtitleUrl}
            srcLang={language}
            label={activeTrack ? trackLabel(activeTrack, sourceLanguage) : languageName(language)}
          />
        ) : null}
      </video>

      {!preparing ? (
        <div
          className={cn(
            'absolute right-3 top-3 z-20 flex items-center gap-1.5 transition-opacity duration-200',
            showBar ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        >
          <SubtitleMenu tracks={tracks} language={language} onSelect={onSelectLanguage} />
          {language ? (
            <CaptionSizeMenu scale={captionScale} onChange={changeCaptionScale} />
          ) : null}
        </div>
      ) : null}

      {!preparing ? (
        <div
          onClick={(event) => event.stopPropagation()}
          className={cn(
            'absolute inset-x-0 bottom-0 z-20 flex flex-col gap-1.5 bg-gradient-to-t from-black/88 via-black/55 to-transparent px-3 pb-2.5 pt-8 transition-opacity duration-200',
            showBar ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        >
          <div className="relative flex h-4 items-center">
            <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/20">
              <div
                className="absolute inset-y-0 left-0 bg-white/35"
                style={{ width: `${bufferedPct}%` }}
              />
              <div
                className="absolute inset-y-0 left-0 bg-accent"
                style={{ width: `${playedPct}%` }}
              />
            </div>
            <input
              type="range"
              aria-label="재생 위치"
              min={0}
              max={duration > 0 ? duration : 100}
              step={0.1}
              value={duration > 0 ? currentTime : 0}
              onChange={(event) => handleSeek(Number(event.target.value))}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </div>

          <div className="flex items-center justify-between gap-2 text-white">
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label={playbackPaused ? '재생' : '일시정지'}
                onClick={togglePlay}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15"
              >
                {playbackPaused ? <Play size={16} fill="currentColor" /> : <Pause size={16} />}
              </button>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label={muted || volume === 0 ? '음소거 해제' : '음소거'}
                  onClick={toggleMute}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-white/90 transition-colors hover:bg-white/15 hover:text-white"
                >
                  {muted || volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
                </button>
                <input
                  type="range"
                  aria-label="음량"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={(event) => handleVolume(Number(event.target.value))}
                  className="hidden h-1 w-16 cursor-pointer accent-accent sm:block"
                />
              </div>

              <span className="ml-1 text-[12px] font-medium tabular-nums text-white/85">
                {formatDuration(currentTime * 1000) || '0:00'}
                <span className="mx-1 text-white/45">/</span>
                {formatDuration(duration * 1000) || '0:00'}
              </span>
            </div>

            <button
              type="button"
              aria-label={appFullscreen ? '전체 화면 종료' : '전체 화면'}
              onClick={toggleFullscreen}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-white/90 transition-colors hover:bg-white/15 hover:text-white"
            >
              {appFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
            </button>
          </div>
        </div>
      ) : null}
      {/*
        The container owns both real and pseudo fullscreen, so this overlay stays
        above the video there. Native fullscreen is the one mode that hides the
        DOM, and only there does the browser draw the cues instead.
      */}
      {!nativeFullscreen && captionLines ? (
        <div
          className="pointer-events-none absolute inset-x-0 z-10 flex justify-center px-3"
          style={{ bottom: showBar ? (appFullscreen ? 104 : 74) : appFullscreen ? 32 : 24 }}
        >
          <span
            className="max-w-[86%] rounded-md bg-black/75 px-3 py-1.5 text-center font-medium leading-[1.4] whitespace-pre-line text-white [overflow-wrap:anywhere] [word-break:keep-all]"
            style={{ fontSize: captionFontSize * captionScale }}
          >
            {captionLines.map((line, index) => {
              // The spoken line sits above the translation, smaller and dimmer
              // so the eye lands on the language the viewer chose.
              const spoken = dual && index === 0
              return (
                <span
                  key={index}
                  className={cn('block', spoken && 'font-normal text-white/60')}
                  style={spoken ? { fontSize: '0.82em' } : undefined}
                >
                  {line}
                </span>
              )
            })}
          </span>
        </div>
      ) : null}
      {preparing ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-lg bg-black/70 text-center">
          <Spinner className="text-accent" />
          <div>
            <p className="text-[13px] font-medium text-white">재생을 준비하고 있습니다</p>
            <p className="mt-1 text-[12px] text-white/75">
              {hlsProgress !== null && hlsProgress > 0
                ? `H.264로 변환하는 중입니다 · ${Math.round(hlsProgress)}%`
                : '이 형식은 브라우저에서 바로 재생되지 않아 H.264로 변환합니다.'}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  )
}
