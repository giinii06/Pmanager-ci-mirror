import { useEffect, useRef, useState, type RefObject } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
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
import { assetUrl } from '../lib/mediaRoutes'
import { useUi } from '../store/ui'
import { posterPositionMs } from '../lib/posterFrame'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { RelatedVideos } from './RelatedVideos'
import { ReviewSection } from './ReviewSection'
import { TranscriptPanel } from './TranscriptPanel'
import { VideoPlayer } from './VideoPlayer'

const PILL =
  'inline-flex min-h-11 items-center gap-2 rounded-xl border border-line bg-panel-2 px-4 text-[13.5px] font-medium text-ink transition-colors hover:border-line-strong hover:bg-raised disabled:cursor-not-allowed disabled:opacity-45'

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

  const capturePoster = useMutation({
    mutationFn: () => {
      const player = videoRef.current
      if (!player) throw new Error('동영상 플레이어를 불러오지 못했습니다.')
      const durationSeconds = Number.isFinite(player.duration) && player.duration > 0
        ? player.duration
        : (asset.durationMs ?? 0) / 1000
      const position = posterPositionMs(player.currentTime, durationSeconds)
      if (position === null) throw new Error('재생 위치를 확인할 수 없습니다.')
      return api.captureThumbnail(asset.id, position)
    },
    onSuccess: ({ asset: updated }) => {
      patchAssetInCaches(queryClient, updated)
      void queryClient.invalidateQueries({ queryKey: ['tags'] })
      toast('현재 재생 장면을 포스터로 저장했습니다.', 'success')
    },
    onError: (error) => toast(error instanceof Error ? error.message : '포스터를 저장하지 못했습니다.', 'error'),
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
      removeAssetFromCaches(queryClient, assetId)
      onClose()
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
    const url = window.location.origin + assetUrl('video', asset.id)
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
    <div className="media-chrome min-h-dvh bg-canvas text-ink">
      <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-line bg-canvas/95 px-4 backdrop-blur sm:px-6">
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="닫기"
          className="rounded-full p-2 text-ink transition-colors hover:bg-panel-2 hover:text-ink"
        >
          <ArrowLeft size={19} />
        </button>
        <p className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
          {asset.filename}
        </p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onPrev}
            aria-label="이전 동영상"
            title={shuffle ? '랜덤 이전 (←)' : '이전 동영상 (←)'}
            className="rounded-full p-1.5 text-muted transition-colors hover:bg-panel-2 hover:text-ink"
          >
            <ChevronLeft size={18} />
          </button>
          <button
            type="button"
            onClick={onNext}
            aria-label="다음 동영상"
            title={shuffle ? '랜덤 다음 (→)' : '다음 동영상 (→)'}
            className="rounded-full p-1.5 text-muted transition-colors hover:bg-panel-2 hover:text-ink"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-[1754px] px-4 py-6 sm:px-6 xl:px-9">
        <div className="grid grid-cols-1 gap-7 xl:grid-cols-[minmax(0,1fr)_424px]">
          <div className="min-w-0">
            <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-line bg-black">
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

            <h1 className="mt-6 text-[clamp(22px,2.2vw,30px)] font-semibold leading-snug tracking-tight text-ink">
              {asset.filename}
            </h1>
            <p className="mt-2 text-[14px] text-muted">{meta.join(' · ')}</p>

            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-line bg-panel px-4 py-3.5 text-[13px] sm:px-5">
              <span className="tabular-nums text-ink">
                조회수: <strong>{formatCount(asset.viewCount)}회</strong>
              </span>
              <span className="tabular-nums text-ink">
                누적 재생 시간: <strong>{formatWatchTime(asset.watchTimeMs)}</strong>
              </span>
              <span className="tabular-nums text-ink">
                Rate: <strong>{formatRate(asset.rate)}</strong>
                {asset.rate === null ? (
                  <span className="ml-1.5 text-[11.5px] text-faint">(아직 데이터 없음)</span>
                ) : null}
              </span>
              <span className="tabular-nums text-ink">
                Vote: <strong>{formatCount(asset.voteCount)}</strong>
              </span>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => vote.mutate()}
                disabled={vote.isPending}
                className={cn(PILL, 'bg-accent/20 text-accent hover:bg-accent/30')}
              >
                <ThumbsUp size={16} />
                Vote {formatCount(asset.voteCount)}
              </button>

              <button
                type="button"
                onClick={() => capturePoster.mutate()}
                disabled={capturePoster.isPending}
                title="현재 재생 장면을 바로 포스터로 저장합니다."
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
                className={cn(PILL, showTranscript && 'bg-raised hover:bg-raised')}
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
                onClick={onToggleShuffle}
                aria-pressed={shuffle}
                title="Shuffle 모드 전환"
                className={cn(PILL, shuffle && 'bg-accent text-[var(--ui-on-accent)] hover:bg-accent/90')}
              >
                <Shuffle size={16} />
                Shuffle {shuffle ? 'ON' : 'OFF'}
              </button>

              <button
                type="button"
                onClick={() => destroyAsset.mutate()}
                disabled={destroyAsset.isPending}
                className={cn(PILL, 'bg-danger/15 text-danger hover:bg-danger/25')}
              >
                <Trash2 size={16} />
                영구 삭제
              </button>
            </div>

            <div className="mt-5 rounded-2xl border border-line bg-panel p-4 sm:p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-muted">
                  <TagIcon size={13} />
                  태그
                </span>
                {asset.tags.map((tag) => (
                  <span
                    key={tag.id}
                    className="inline-flex items-center gap-1 rounded-full border border-line bg-panel-2 px-2.5 py-0.5 text-[12px] text-ink"
                  >
                    {tag.name}
                    <button
                      type="button"
                      onClick={() => detachTag.mutate(tag.id)}
                      aria-label={`${tag.name} 태그 제거`}
                      className="rounded-full p-0.5 text-muted hover:bg-raised hover:text-ink"
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
                {asset.tags.length === 0 ? (
                  <span className="text-[12px] text-faint">지정된 태그 없음</span>
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
                    className="h-8 w-44 bg-panel-2 text-[12px]"
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
                    className="h-8 rounded-md border border-line bg-panel-2 px-2.5 text-[12px] text-ink focus:border-accent/50 focus:outline-none"
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

            <div ref={descriptionRef} className="mt-5 scroll-mt-20 rounded-2xl border border-line bg-panel-2 p-4 sm:p-5">
              <p className="text-[13px] font-medium text-ink">
                후기 {reviewCount}개 · {formatDay(asset.takenAt)}
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12.5px]">
                {facts.map((fact) => (
                  <div key={fact.label} className={cn(fact.wide && 'col-span-2')}>
                    <dt className="text-faint">{fact.label}</dt>
                    <dd className="mt-0.5 break-all text-muted">{fact.value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <ReviewSection key={asset.id} asset={asset} />
          </div>

          <div className="min-w-0">
            {showTranscript ? (
              <div className="h-[580px] overflow-hidden rounded-2xl border border-line">
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
