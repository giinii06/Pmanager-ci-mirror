import { useEffect, useRef, useState, type RefObject } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Bookmark,
  Camera,
  Captions,
  ChevronLeft,
  ChevronRight,
  Download,
  Info,
  Plus,
  Share2,
  Shuffle,
  Tag as TagIcon,
  ThumbsUp,
  Trash2,
  X,
} from 'lucide-react'
import { extensionOf, type AssetDTO, type SubtitleTrackDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { invalidateVoteCaches, patchAssetInCaches, removeAssetFromCaches } from '../lib/cachePatch'
import { cn } from '../lib/cn'
import { monitorBackgroundDelete } from '../lib/backgroundDelete'
import {
  formatBytes,
  formatCount,
  formatDay,
  formatDuration,
  formatRate,
  formatWatchTime,
} from '../lib/format'
import { randomToken } from '../lib/random'
import { useUi } from '../store/ui'
import { BookmarkDialog } from './BookmarkDialog'
import { PosterDialog } from './PosterDialog'
import { Dialog } from './ui/Dialog'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { RelatedVideos } from './RelatedVideos'
import { ReviewSection } from './ReviewSection'
import { TranscriptPanel } from './TranscriptPanel'
import { VideoPlayer } from './VideoPlayer'

const PILL =
  'inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/10 bg-white/10 px-4 text-[13.5px] font-medium text-white transition-colors hover:border-white/25 hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-45'

export function WatchPage({
  asset,
  libraryName,
  shuffle,
  onToggleShuffle,
  onPrev,
  onNext,
  browserFill,
  onBrowserFillChange,
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
  shuffle: boolean
  onToggleShuffle: () => void
  onPrev: () => void
  onNext: () => void
  browserFill: boolean
  onBrowserFillChange: (enabled: boolean) => void
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
  infoSignal: number
  closeRef: RefObject<HTMLButtonElement | null>
  startMs?: number | null
}) {
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const [copied, setCopied] = useState(false)
  const [tagInput, setTagInput] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [bookmarkOpen, setBookmarkOpen] = useState(false)
  const [posterOpen, setPosterOpen] = useState(false)
  const copyTimer = useRef<number | null>(null)
  const descriptionRef = useRef<HTMLDivElement>(null)

  const tagsQuery = useQuery({ queryKey: ['tags', 'video'], queryFn: () => api.tags('video') })
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

  const vote = useMutation({
    mutationFn: () => api.voteAsset(asset.id, randomToken()),
    onSuccess: (updated) => {
      patchAssetInCaches(queryClient, updated)
      invalidateVoteCaches(queryClient)
      queryClient.invalidateQueries({ queryKey: ['stats'] })
    },
    onError: () => toast('투표하지 못했습니다.', 'error'),
  })

  const attachTag = useMutation({
    mutationFn: (payload: { tagId?: string; name?: string }) => api.attachTag(asset.id, payload),
    onSuccess: ({ asset: updated }) => {
      patchAssetInCaches(queryClient, updated)
      queryClient.invalidateQueries({ queryKey: ['tags', 'video'] })
      setTagInput('')
    },
    onError: (err) =>
      toast(err instanceof Error ? err.message : '태그를 추가하지 못했습니다.', 'error'),
  })

  const detachTag = useMutation({
    mutationFn: (tagId: string) => api.detachTag(asset.id, tagId),
    onSuccess: ({ asset: updated }) => {
      patchAssetInCaches(queryClient, updated)
      queryClient.invalidateQueries({ queryKey: ['tags'] })
    },
    onError: () => toast('태그를 제거하지 못했습니다.', 'error'),
  })

  const deleteKeyRef = useRef(`${asset.id}:${randomToken()}`)
  useEffect(() => {
    deleteKeyRef.current = `${asset.id}:${randomToken()}`
  }, [asset.id])

  const destroyAsset = useMutation({
    mutationFn: async () => {
      const assetId = asset.id
      const operation = await api.createDeleteOperation(assetId, deleteKeyRef.current)
      if (operation.state === 'blocked' || operation.state === 'cancelled_pre_commit') {
        throw new Error('삭제를 진행할 수 없습니다. 라이브러리 상태를 확인해 주세요.')
      }
      return { assetId, operation }
    },
    onSuccess: ({ assetId, operation }) => {
      // The server has durably queued the delete; don't hold the UI until the
      // worker quarantines, commits and purges the original file.
      setDeleteOpen(false)
      removeAssetFromCaches(queryClient, assetId)
      toast('동영상을 목록에서 제거했습니다. 파일은 백그라운드에서 영구 삭제 중입니다.', 'success')

      if (operation.state === 'completed') return
      void monitorBackgroundDelete(
        () => api.getFileOperation(operation.id).then((status) => status.state),
        (ms) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)),
      ).then((outcome) => {
        if (outcome !== 'failed') return
        // A blocked pre-commit delete may restore its asset tombstone.
        toast('백그라운드 영구 삭제가 실패했습니다. 라이브러리 상태를 확인해 주세요.', 'error')
        void queryClient.invalidateQueries({ queryKey: ['assets'] })
        void queryClient.invalidateQueries({ queryKey: ['stats'] })
        void queryClient.invalidateQueries({ queryKey: ['folders'] })
      })
    },
    onError: (err) =>
      toast(err instanceof Error ? err.message : '삭제 요청을 접수하지 못했습니다.', 'error'),
  })

  useEffect(() => {
    setDeleteOpen(false)
    setBookmarkOpen(false)
    setTagInput('')
  }, [asset.id])

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

  const allTags = tagsQuery.data?.tags ?? []
  const attachedIds = new Set(asset.tags.map((t) => t.id))
  const availableTags = allTags.filter((t) => !attachedIds.has(t.id))
  const relatedItems = related.data?.items ?? []
  const reviewCount = review.data?.review ? 1 : 0
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
      <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-white/10 bg-[#0f0f0f]/95 px-4 backdrop-blur sm:px-6">
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
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onPrev}
            aria-label="이전 동영상"
            title={shuffle ? '랜덤 이전 (←)' : '이전 동영상 (←)'}
            className="rounded-full p-1.5 text-white/75 transition-colors hover:bg-white/10 hover:text-white"
          >
            <ChevronLeft size={18} />
          </button>
          <button
            type="button"
            onClick={onNext}
            aria-label="다음 동영상"
            title={shuffle ? '랜덤 다음 (→)' : '다음 동영상 (→)'}
            className="rounded-full p-1.5 text-white/75 transition-colors hover:bg-white/10 hover:text-white"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-[1754px] px-4 py-6 sm:px-6 xl:px-9">
        <div className="grid grid-cols-1 gap-7 xl:grid-cols-[minmax(0,1fr)_424px]">
          <div className="min-w-0">
            <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-black">
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
                browserFill={browserFill}
                onBrowserFillChange={onBrowserFillChange}
                onPrev={onPrev}
                onNext={onNext}
              />
            </div>

            <h1 className="mt-6 text-[clamp(22px,2.2vw,30px)] font-semibold leading-snug tracking-tight text-white">
              {asset.filename}
            </h1>
            <p className="mt-2 text-[14px] text-white/60">{meta.join(' · ')}</p>

            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3.5 text-[13px] sm:px-5">
              <span className="tabular-nums text-white/85">
                조회수: <strong>{formatCount(asset.viewCount)}회</strong>
              </span>
              <span className="tabular-nums text-white/85">
                누적 재생 시간: <strong>{formatWatchTime(asset.watchTimeMs)}</strong>
              </span>
              <span className="tabular-nums text-white/85">
                Rate: <strong>{formatRate(asset.rate)}</strong>
                {asset.rate === null ? (
                  <span className="ml-1.5 text-[11.5px] text-white/45">(아직 데이터 없음)</span>
                ) : null}
              </span>
              <span className="tabular-nums text-white/85">
                Vote: <strong>{formatCount(asset.voteCount)}</strong>
              </span>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => vote.mutate()}
                disabled={vote.isPending}
                className={cn(PILL, 'bg-accent/20 text-white hover:bg-accent/30')}
              >
                <ThumbsUp size={16} />
                Vote {formatCount(asset.voteCount)}
              </button>

              <button
                type="button"
                onClick={() => setPosterOpen(true)}
                title="타임라인에서 포스터로 사용할 프레임을 고릅니다."
                className={PILL}
              >
                <Camera size={16} />
                포스터 선택
              </button>

              <button type="button" onClick={() => void share()} className={PILL}>
                <Share2 size={16} />
                {copied ? '복사됨' : '공유'}
              </button>

              <a
                href={`${asset.streamUrl}&download=1`}
                download={asset.filename}
                className={PILL}
              >
                <Download size={16} />
                원본 내려받기
              </a>

              <button
                type="button"
                aria-pressed={showTranscript}
                onClick={onToggleTranscript}
                className={cn(PILL, showTranscript && 'bg-white/20 hover:bg-white/20')}
              >
                <Captions size={16} />
                AI 자막
              </button>

              <button
                type="button"
                onClick={() => descriptionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                className={PILL}
              >
                <Info size={16} />
                정보
              </button>

              <button
                type="button"
                onClick={() => setBookmarkOpen(true)}
                title="현재 위치에 타임스탬프를 남깁니다."
                className={PILL}
              >
                <Bookmark size={16} />
                북마크
              </button>

              <button
                type="button"
                onClick={onToggleShuffle}
                aria-pressed={shuffle}
                title="Shuffle 모드 전환"
                className={cn(PILL, shuffle && 'bg-accent text-white hover:bg-accent/90')}
              >
                <Shuffle size={16} />
                Shuffle {shuffle ? 'ON' : 'OFF'}
              </button>

              <button
                type="button"
                onClick={() => setDeleteOpen(true)}
                className={cn(PILL, 'bg-[#3c191d] text-[#ffc9c9] hover:bg-[#522127]')}
              >
                <Trash2 size={16} />
                영구 삭제
              </button>
            </div>

            <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.04] p-4 sm:p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-white/75">
                  <TagIcon size={13} />
                  태그
                </span>
                {asset.tags.map((tag) => (
                  <span
                    key={tag.id}
                    className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/10 px-2.5 py-0.5 text-[12px] text-white"
                  >
                    {tag.name}
                    <button
                      type="button"
                      onClick={() => detachTag.mutate(tag.id)}
                      aria-label={`${tag.name} 태그 제거`}
                      className="rounded-full p-0.5 text-white/60 hover:bg-white/15 hover:text-white"
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
                {asset.tags.length === 0 ? (
                  <span className="text-[12px] text-white/40">지정된 태그 없음</span>
                ) : null}
              </div>

              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <form
                  className="flex items-center gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const trimmed = tagInput.trim()
                    if (trimmed) attachTag.mutate({ name: trimmed })
                  }}
                >
                  <Input
                    value={tagInput}
                    onChange={(event) => setTagInput(event.target.value)}
                    placeholder="새 태그 또는 이름 입력"
                    className="h-8 w-44 bg-black/40 text-[12px]"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!tagInput.trim() || attachTag.isPending}
                  >
                    <Plus size={12} />
                    추가
                  </Button>
                </form>

                {availableTags.length > 0 ? (
                  <select
                    aria-label="기존 태그 추가"
                    value=""
                    onChange={(event) => {
                      const val = event.target.value
                      if (val) attachTag.mutate({ tagId: val })
                    }}
                    className="h-8 rounded-md border border-line bg-black/40 px-2.5 text-[12px] text-white focus:border-accent/50 focus:outline-none"
                  >
                    <option value="">기존 태그 선택...</option>
                    {availableTags.map((tag) => (
                      <option key={tag.id} value={tag.id}>
                        {tag.name}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
            </div>

            <div ref={descriptionRef} className="mt-5 scroll-mt-20 rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-5">
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
              <div className="h-[580px] overflow-hidden rounded-2xl border border-white/10">
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

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="동영상을 영구 삭제할까요?"
        description="요청이 접수되면 목록에서 즉시 제거되고, 서버가 원본 파일과 관련 데이터를 백그라운드에서 영구 삭제합니다. 이 작업은 되돌릴 수 없습니다."
        footer={
          <>
            <Button onClick={() => setDeleteOpen(false)}>취소</Button>
            <Button
              variant="danger"
              disabled={destroyAsset.isPending}
              onClick={() => destroyAsset.mutate()}
            >
              {destroyAsset.isPending ? '삭제 요청 중...' : '영구 삭제'}
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-muted">
          <span className="font-medium text-ink">{asset.filename}</span> 파일과 썸네일, 자막, 태그,
          조회수, 누적 재생 시간, Vote 기록이 영구적으로 제거됩니다.
        </p>
      </Dialog>

      <BookmarkDialog
        open={bookmarkOpen}
        onClose={() => setBookmarkOpen(false)}
        asset={asset}
        videoRef={videoRef}
      />

      <PosterDialog
        open={posterOpen}
        onClose={() => setPosterOpen(false)}
        asset={asset}
        videoRef={videoRef}
      />
    </div>
  )
}
