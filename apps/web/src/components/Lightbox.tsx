import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { useQuery } from '@tanstack/react-query'
import type { SubtitleTrackDTO } from '@mediavault/shared'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Heart,
  Info,
  Maximize2,
  Minimize2,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { formatBytes, formatDate } from '../lib/format'
import { cn } from '../lib/cn'
import { useFavorite } from '../lib/useFavorite'
import { useViewer } from '../store/viewer'
import { WatchPage } from './WatchPage'
import { Spinner } from './ui/Spinner'

const NO_TRACKS: SubtitleTrackDTO[] = []

function IconButton({
  label,
  onClick,
  children,
  active,
}: {
  label: string
  onClick: () => void
  children: ReactNode
  active?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'rounded-full p-2 transition-colors',
        active
          ? 'bg-white/15 text-accent'
          : 'text-white/75 hover:bg-white/10 hover:text-white',
      )}
    >
      {children}
    </button>
  )
}

export function Lightbox() {
  const items = useViewer((state) => state.items)
  const index = useViewer((state) => state.index)
  const startMs = useViewer((state) => state.startMs)
  const close = useViewer((state) => state.close)
  const next = useViewer((state) => state.next)
  const prev = useViewer((state) => state.prev)
  const select = useViewer((state) => state.select)
  const favorite = useFavorite()

  const asset = items[index]
  const [showInfo, setShowInfo] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)
  const [infoPulse, setInfoPulse] = useState(0)
  const [fullRes, setFullRes] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const watchScrollRef = useRef<HTMLDivElement>(null)

  const libraries = useQuery({ queryKey: ['libraries'], queryFn: api.libraries })
  const libraryName = libraries.data?.find((library) => library.id === asset?.libraryId)?.name
  const open = Boolean(asset)

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

  // A choice outlives refetches of the tracks, so a translation turning ready
  // never pulls the viewer off the language they picked for this asset.
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
    setShowInfo(false)
    setFullRes(false)
    setLoaded(false)
  }, [asset?.id])

  // The transcript panel follows the viewer across related videos, but an
  // image has no transcript to keep open.
  useEffect(() => {
    if (!asset || asset.kind !== 'video') setShowTranscript(false)
  }, [asset?.id, asset?.kind])

  useEffect(() => {
    if (asset?.kind !== 'video') return
    watchScrollRef.current?.scrollTo({ top: 0 })
  }, [asset?.id, asset?.kind])

  useEffect(() => {
    if (!asset) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (event.key === 'Escape') {
        // The same keypress that leaves fullscreen must not also close the viewer.
        if (document.fullscreenElement) return
        close()
      }
      else if (event.key === 'ArrowRight') next()
      else if (event.key === 'ArrowLeft') prev()
      else if (event.key.toLowerCase() === 'f' && asset)
        favorite.mutate({ id: asset.id, favorite: !asset.favorite })
      else if (event.key.toLowerCase() === 'i') {
        if (asset.kind === 'video') setInfoPulse((value) => value + 1)
        else setShowInfo((value) => !value)
      } else if (event.key.toLowerCase() === 'c' && asset.kind === 'video')
        setShowTranscript((value) => !value)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [asset, close, favorite, next, prev])

  useEffect(() => {
    if (!open) return
    const original = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    return () => {
      document.body.style.overflow = original
    }
  }, [open])

  useEffect(() => {
    if (!asset || asset.kind !== 'image') return
    const neighbors = [items[index - 1], items[index + 1]].filter(
      (item): item is NonNullable<typeof item> => Boolean(item && item.kind === 'image'),
    )
    for (const neighbor of neighbors) {
      const image = new Image()
      image.src = neighbor.previewUrl
    }
  }, [asset, index, items])

  const canPrev = index > 0
  const canNext = index < items.length - 1

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
              favorite={favorite}
              onClose={close}
              onSelectAsset={select}
              subtitleUrl={subtitleUrl}
              tracks={tracks}
              language={language}
              onSelectLanguage={(next) =>
                setSubtitleChoice({ assetId: asset.id, language: next })
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
              if (event.target === event.currentTarget) close()
            }}
          >
            <div className="relative z-20 flex items-center justify-between gap-4 bg-gradient-to-b from-black/70 to-transparent px-3 py-2.5 sm:px-5">
              <div className="flex min-w-0 items-center gap-2.5">
                <button
                  ref={closeRef}
                  type="button"
                  onClick={close}
                  aria-label="닫기"
                  className="rounded-full p-2 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <X size={19} />
                </button>
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-white">{asset.filename}</p>
                  <p className="truncate text-[11.5px] text-white/45">
                    {formatDate(asset.takenAt)}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-0.5">
                <IconButton
                  label={asset.favorite ? '즐겨찾기 해제' : '즐겨찾기'}
                  active={asset.favorite}
                  onClick={() =>
                    favorite.mutate({ id: asset.id, favorite: !asset.favorite })
                  }
                >
                  <Heart size={17} fill={asset.favorite ? 'currentColor' : 'none'} />
                </IconButton>
                <IconButton
                  label={fullRes ? '미리보기로 보기' : '원본으로 보기'}
                  active={fullRes}
                  onClick={() => setFullRes((value) => !value)}
                >
                  {fullRes ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
                </IconButton>
                <IconButton
                  label="정보"
                  active={showInfo}
                  onClick={() => setShowInfo((value) => !value)}
                >
                  <Info size={17} />
                </IconButton>
                <a
                  href={`${asset.streamUrl}&download=1`}
                  download={asset.filename}
                  aria-label="원본 내려받기"
                  title="원본 내려받기"
                  className="rounded-full p-2 text-white/75 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <Download size={17} />
                </a>
              </div>
            </div>

            <div className="relative flex min-h-0 flex-1 items-center justify-center px-3 pb-3 sm:px-16">
              {canPrev ? (
                <button
                  type="button"
                  onClick={prev}
                  aria-label="이전"
                  className="absolute left-1 z-20 rounded-full bg-black/40 p-2.5 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/65 hover:text-white sm:left-4"
                >
                  <ChevronLeft size={20} />
                </button>
              ) : null}

              <div className="relative flex h-full w-full items-center justify-center">
                <img
                  src={asset.thumbnails.medium}
                  alt=""
                  aria-hidden
                  className="pointer-events-none absolute max-h-[70%] max-w-[70%] scale-105 object-contain opacity-35 blur-2xl"
                />
                {!loaded ? (
                  <div className="absolute">
                    <Spinner className="text-white/60" />
                  </div>
                ) : null}
                <motion.img
                  key={`${asset.id}-${fullRes ? 'full' : 'preview'}`}
                  src={fullRes ? asset.streamUrl : asset.previewUrl}
                  alt={asset.filename}
                  onLoad={() => setLoaded(true)}
                  className={cn(
                    'relative max-h-[calc(100dvh-150px)] max-w-full rounded-[6px] object-contain shadow-[0_20px_80px_rgba(0,0,0,0.65)] transition-opacity duration-200',
                    loaded ? 'opacity-100' : 'opacity-0',
                  )}
                  initial={{ opacity: 0, scale: 0.985 }}
                  animate={{ opacity: loaded ? 1 : 0, scale: 1 }}
                  transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
                />
              </div>

              {canNext ? (
                <button
                  type="button"
                  onClick={next}
                  aria-label="다음"
                  className="absolute right-1 z-20 rounded-full bg-black/40 p-2.5 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/65 hover:text-white sm:right-4"
                >
                  <ChevronRight size={20} />
                </button>
              ) : null}

              <AnimatePresence>
                {showInfo ? (
                  <motion.aside
                    key="info"
                    initial={{ x: 24, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    exit={{ x: 24, opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    className="absolute bottom-0 right-0 top-0 z-30 w-[300px] max-w-[86vw] overflow-y-auto border-l border-white/10 bg-[#0b0c0f]/97 px-5 py-6"
                  >
                    <h3 className="text-[13px] font-semibold text-ink">정보</h3>
                    <dl className="mt-4 space-y-3.5 text-[12.5px]">
                      <div>
                        <dt className="text-faint">파일 이름</dt>
                        <dd className="mt-0.5 break-all text-ink">{asset.filename}</dd>
                      </div>
                      <div>
                        <dt className="text-faint">촬영일</dt>
                        <dd className="mt-0.5 text-ink">{formatDate(asset.takenAt)}</dd>
                      </div>
                      <div>
                        <dt className="text-faint">해상도</dt>
                        <dd className="mt-0.5 tabular-nums text-ink">
                          {asset.width && asset.height
                            ? `${asset.width} × ${asset.height}`
                            : '알 수 없음'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-faint">용량</dt>
                        <dd className="mt-0.5 tabular-nums text-ink">
                          {formatBytes(asset.sizeBytes)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-faint">형식</dt>
                        <dd className="mt-0.5 text-ink">{asset.mimeType}</dd>
                      </div>
                      <div>
                        <dt className="text-faint">라이브러리</dt>
                        <dd className="mt-0.5 text-ink">{libraryName ?? asset.libraryId}</dd>
                      </div>
                      <div>
                        <dt className="text-faint">경로</dt>
                        <dd className="mt-0.5 break-all text-muted">{asset.relativePath}</dd>
                      </div>
                    </dl>
                  </motion.aside>
                ) : null}
              </AnimatePresence>
            </div>

            <div className="pointer-events-none absolute bottom-3 left-0 right-0 z-10 flex items-center justify-center gap-3 text-[11.5px] text-white/45">
              <span className="tabular-nums">
                {index + 1} / {items.length}
              </span>
              {asset.width && asset.height ? (
                <span className="tabular-nums">
                  {asset.width} × {asset.height}
                </span>
              ) : null}
            </div>
          </motion.div>
        )
      ) : null}
    </AnimatePresence>,
    document.body,
  )
}
