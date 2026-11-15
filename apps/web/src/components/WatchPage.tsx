import { useEffect, useRef, useState, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Captions, Download, Heart, Info, Share2 } from 'lucide-react'
import { extensionOf, type AssetDTO, type SubtitleTrackDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { formatBytes, formatDay, formatDuration } from '../lib/format'
import { useUi } from '../store/ui'
import { RelatedVideos } from './RelatedVideos'
import { ReviewSection } from './ReviewSection'
import { TranscriptPanel } from './TranscriptPanel'
import { VideoPlayer } from './VideoPlayer'

const PILL =
  'inline-flex h-9 items-center gap-2 rounded-full bg-white/10 px-4 text-[13px] font-medium text-white transition-colors hover:bg-white/15'

interface FavoriteMutation {
  mutate: (variables: { id: string; favorite: boolean }) => void
}

export function WatchPage({
  asset,
  libraryName,
  favorite,
  onClose,
  onSelectAsset,
  subtitleUrl,
  tracks,
  language,
  onSelectLanguage,
  videoRef,
  showTranscript,
  onToggleTranscript,
  onCloseTranscript,
  infoSignal,
  closeRef,
  startMs = null,
}: {
  asset: AssetDTO
  libraryName?: string
  favorite: FavoriteMutation
  onClose: () => void
  onSelectAsset: (asset: AssetDTO) => void
  subtitleUrl: string | null
  tracks: SubtitleTrackDTO[]
  language: string | null
  onSelectLanguage: (language: string | null) => void
  videoRef: RefObject<HTMLVideoElement | null>
  showTranscript: boolean
  onToggleTranscript: () => void
  onCloseTranscript: () => void
  /** Bumped by the `i` shortcut so the description can scroll into view. */
  infoSignal: number
  closeRef: RefObject<HTMLButtonElement | null>
  startMs?: number | null
}) {
  const toast = useUi((state) => state.toast)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)
  const descriptionRef = useRef<HTMLDivElement>(null)

  const related = useQuery({
    queryKey: ['related', asset.id],
    queryFn: () => api.related(asset.id, 8),
    staleTime: 30_000,
  })
  const review = useQuery({
    queryKey: ['review', asset.id],
    queryFn: () => api.review(asset.id),
    staleTime: 30_000,
  })

  const relatedItems = related.data?.items ?? []
  const reviewCount = review.data?.review ? 1 : 0

  const scrollToDescription = () => {
    descriptionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  useEffect(() => {
    if (infoSignal === 0) return
    descriptionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [infoSignal])

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    },
    [],
  )

  // The pill row mirrors YouTube's, but a share link has to open this video,
  // so the id travels in the URL and the videos page reads it back.
  const share = async () => {
    const url = `${window.location.origin}/videos?v=${encodeURIComponent(asset.id)}`
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600)
    } catch {
      toast('링크를 복사하지 못했습니다.', 'error')
    }
  }

  const codec = [asset.videoCodec, asset.audioCodec].filter(Boolean).join(' · ')
  const container = asset.container?.toUpperCase() || extensionOf(asset.filename).toUpperCase()

  const facts: { label: string; value: string; wide?: boolean }[] = [
    { label: '경로', value: asset.relativePath, wide: true },
    { label: '크기', value: formatBytes(asset.sizeBytes) },
    {
      label: '해상도',
      value: asset.width && asset.height ? `${asset.width} × ${asset.height}` : '알 수 없음',
    },
    { label: '코덱', value: codec || '알 수 없음' },
    { label: '컨테이너', value: container || '알 수 없음' },
  ]

  const meta = [
    libraryName ?? asset.libraryId,
    formatDay(asset.takenAt),
    asset.width && asset.height ? `${asset.width} × ${asset.height}` : null,
    formatDuration(asset.durationMs) || null,
  ].filter(Boolean)

  return (
    <div className="min-h-dvh bg-[#0f0f0f] text-white">
      <header className="sticky top-0 z-30 flex h-12 items-center gap-1.5 border-b border-white/5 bg-[#0f0f0f]/95 px-3 backdrop-blur sm:px-4">
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="닫기"
          className="rounded-full p-2 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
        >
          <ArrowLeft size={19} />
        </button>
        <p className="min-w-0 flex-1 truncate text-[14px] font-medium text-white">
          {asset.filename}
        </p>
      </header>

      <div className="mx-auto max-w-[1754px] px-6 py-4">
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_402px]">
          <div className="min-w-0">
            <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black">
              <VideoPlayer
                key={asset.id}
                fill
                asset={asset}
                subtitleUrl={subtitleUrl}
                tracks={tracks}
                language={language}
                onSelectLanguage={onSelectLanguage}
                videoRef={videoRef}
                startMs={startMs}
              />
            </div>

            <h1 className="mt-4 text-[20px] font-semibold leading-snug text-white">
              {asset.filename}
            </h1>
            <p className="mt-1 text-[13px] text-white/55">{meta.join(' · ')}</p>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                aria-pressed={asset.favorite}
                onClick={() => favorite.mutate({ id: asset.id, favorite: !asset.favorite })}
                className={cn(
                  PILL,
                  asset.favorite && 'bg-accent/15 text-accent hover:bg-accent/20',
                )}
              >
                <Heart
                  size={17}
                  fill={asset.favorite ? '#ff4e45' : 'none'}
                  className={asset.favorite ? 'text-[#ff4e45]' : undefined}
                />
                좋아요
              </button>

              <button type="button" onClick={() => void share()} className={PILL}>
                <Share2 size={17} />
                {copied ? '복사됨' : '공유'}
              </button>

              <a
                href={`${asset.streamUrl}&download=1`}
                download={asset.filename}
                className={PILL}
              >
                <Download size={17} />
                원본 내려받기
              </a>

              <button
                type="button"
                aria-pressed={showTranscript}
                onClick={onToggleTranscript}
                className={cn(PILL, showTranscript && 'bg-white/20 hover:bg-white/20')}
              >
                <Captions size={17} />
                AI 자막
              </button>

              <button type="button" onClick={scrollToDescription} className={PILL}>
                <Info size={17} />
                정보
              </button>
            </div>

            <div ref={descriptionRef} className="mt-4 scroll-mt-16 rounded-xl bg-white/5 p-3">
              <p className="text-[13px] font-medium text-white">
                후기 {reviewCount}개 · {formatDay(asset.takenAt)}
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12.5px]">
                {facts.map((fact) => (
                  <div key={fact.label} className={cn(fact.wide && 'col-span-2')}>
                    <dt className="text-white/45">{fact.label}</dt>
                    <dd className="mt-0.5 break-all text-white/75">{fact.value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <ReviewSection key={asset.id} asset={asset} />
          </div>

          <div className="min-w-0">
            {showTranscript ? (
              <div className="h-[560px] overflow-hidden rounded-xl">
                <TranscriptPanel
                  asset={asset}
                  tracks={tracks}
                  language={language}
                  videoRef={videoRef}
                  onClose={onCloseTranscript}
                />
              </div>
            ) : (
              <RelatedVideos
                items={relatedItems}
                loading={related.isPending}
                onSelect={onSelectAsset}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
