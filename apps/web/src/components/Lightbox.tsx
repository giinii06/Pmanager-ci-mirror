import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { useQuery } from '@tanstack/react-query'
import type { SubtitleTrackDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { useViewer } from '../store/viewer'
import { assetUrl, isMediaPath } from '../lib/mediaRoutes'
import { ImageViewer } from './ImageViewer'
import { WatchPage } from './WatchPage'

const NO_TRACKS: SubtitleTrackDTO[] = []

export function Lightbox() {
  const location = useLocation()
  const navigate = useNavigate()
  const items = useViewer((state) => state.items)
  const index = useViewer((state) => state.index)
  const startMs = useViewer((state) => state.startMs)
  const shuffle = useViewer((state) => state.shuffle)
  const browserFill = useViewer((state) => state.browserFill)
  const setBrowserFill = useViewer((state) => state.setBrowserFill)
  const toggleShuffle = useViewer((state) => state.toggleShuffle)
  const close = useViewer((state) => state.close)
  const next = useViewer((state) => state.next)
  const prev = useViewer((state) => state.prev)
  const select = useViewer((state) => state.select)

  const asset = items[index]
  const [showTranscript, setShowTranscript] = useState(false)
  const [infoPulse, setInfoPulse] = useState(0)
  const closeRef = useRef<HTMLButtonElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const watchScrollRef = useRef<HTMLDivElement>(null)
  const lastAssetId = useRef<string | null>(null)

  const libraries = useQuery({ queryKey: ['libraries'], queryFn: api.libraries })
  const libraryName = libraries.data?.find((library) => library.id === asset?.libraryId)?.name
  const open = Boolean(asset)
  const background = typeof (location.state as { background?: unknown } | null)?.background === 'string'
    ? (location.state as { background: string }).background : null

  const closeMedia = () => {
    close()
    if (isMediaPath(location.pathname)) {
      const destination = background?.startsWith('/') && !background.startsWith('//')
        ? background : (asset?.kind === 'video' ? '/videos' : '/')
      navigate(destination, { replace: true })
    }
  }

  useEffect(() => {
    const previous = lastAssetId.current
    lastAssetId.current = asset?.id ?? null
    if (!asset || !previous || previous === asset.id || !isMediaPath(location.pathname)) return
    // A browser POP already points at the selected ID; don't push a duplicate.
    if (location.pathname === assetUrl(asset.kind, previous)) {
      navigate(assetUrl(asset.kind, asset.id), { state: location.state })
    }
  }, [asset?.id])

  const subtitleTracks = useQuery({
    queryKey: ['subtitle-tracks', asset?.id],
    queryFn: () => api.subtitleTracks(asset!.id),
    enabled: open && asset?.kind === 'video',
    staleTime: 30_000,
  })
  const tracks = subtitleTracks.data?.tracks ?? NO_TRACKS
  const sourceTrack = tracks.find((track) => track.source === 'asr')
  const defaultLanguage =
    subtitleTracks.data?.defaultLanguage === 'original'
      ? (sourceTrack?.language ?? null)
      : (subtitleTracks.data?.defaultLanguage ?? null)

  const [subtitleChoice, setSubtitleChoice] = useState<{
    assetId: string
    language: string | null
  } | null>(null)
  const language =
    subtitleChoice && subtitleChoice.assetId === asset?.id
      ? subtitleChoice.language
      : defaultLanguage
  const subtitleUrl =
    asset?.kind === 'video' && language ? api.vttUrl(asset.id, asset.fileVersion, language) : null

  useEffect(() => {
    if (!asset || asset.kind !== 'video') setShowTranscript(false)
  }, [asset?.id, asset?.kind])

  useEffect(() => {
    if (asset?.kind !== 'video') return
    watchScrollRef.current?.scrollTo({ top: 0 })
  }, [asset?.id, asset?.kind])

  useEffect(() => {
    if (!asset || asset.kind !== 'video') return
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (event.key === 'Escape') {
        if (document.fullscreenElement) return
        if (browserFill) {
          setBrowserFill(false)
          return
        }
        closeMedia()
      }
      else if (event.key === 'ArrowRight') next()
      else if (event.key === 'ArrowLeft') prev()
      else if (event.key.toLowerCase() === 'i') setInfoPulse((value) => value + 1)
      else if (event.key.toLowerCase() === 'c') setShowTranscript((value) => !value)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [asset, browserFill, setBrowserFill, closeMedia, next, prev])

  useEffect(() => {
    if (!open) return
    const original = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    return () => {
      document.body.style.overflow = original
    }
  }, [open])

  return createPortal(
    <AnimatePresence>
      {open && asset ? (
        asset.kind === 'video' ? (
          <motion.div
            key="watch"
            ref={watchScrollRef}
            className="fixed inset-0 z-[70] overflow-y-auto overscroll-contain bg-[#0f0f0f]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <WatchPage
              asset={asset}
              libraryName={libraryName}
              shuffle={shuffle}
              onToggleShuffle={toggleShuffle}
              onPrev={prev}
              onNext={next}
              browserFill={browserFill}
              onBrowserFillChange={setBrowserFill}
              onClose={closeMedia}
              onSelectAsset={select}
              subtitleUrl={subtitleUrl}
              tracks={tracks}
              language={language}
              onSelectLanguage={(nextLang) =>
                setSubtitleChoice({ assetId: asset.id, language: nextLang })
              }
              videoRef={videoRef}
              showTranscript={showTranscript}
              onToggleTranscript={() => setShowTranscript((value) => !value)}
              onCloseTranscript={() => setShowTranscript(false)}
              infoSignal={infoPulse}
              closeRef={closeRef}
              startMs={startMs}
            />
          </motion.div>
        ) : (
          <motion.div
            key="lightbox"
            className="fixed inset-0 z-[70] flex flex-col bg-[#05060a]/95 backdrop-blur-[6px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeMedia()
            }}
          >
            <ImageViewer
              asset={asset}
              items={items}
              index={index}
              libraryName={libraryName}
              closeRef={closeRef}
              onClose={closeMedia}
              onSelect={select}
            />
          </motion.div>
        )
      ) : null}
    </AnimatePresence>,
    document.body,
  )
}
