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
import { Dialog } from './ui/Dialog'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { RelatedVideos } from './RelatedVideos'
import { ReviewSection } from './ReviewSection'
import { TranscriptPanel } from './TranscriptPanel'
import { VideoPlayer } from './VideoPlayer'

const PILL =
  'inline-flex h-9 items-center gap-2 rounded-full bg-white/10 px-4 text-[13px] font-medium text-white transition-colors hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-45'

export function WatchPage({
  asset,
  libraryName,
  shuffle,
  onToggleShuffle,
  onPrev,
  onNext,
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
  const [paused, setPaused] = useState(true)
  const [tagInput, setTagInput] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const copyTimer = useRef<number | null>(null)
  const descriptionRef = useRef<HTMLDivElement>(null)

  const tagsQuery = useQuery({ queryKey: ['tags'], queryFn: api.tags })
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

  const capturePoster = useMutation({
    mutationFn: () => {
      const el = videoRef.current
      const positionMs = el && Number.isFinite(el.currentTime) ? Math.round(el.currentTime * 1000) : 0
      return api.captureThumbnail(asset.id, positionMs)
    },
    onSuccess: ({ asset: updated }) => {
      patchAssetInCaches(queryClient, updated)
      queryClient.invalidateQueries({ queryKey: ['tags'] })
      toast('현재 프레임을 썸네일로 저장했습니다.', 'success')
    },
    onError: (err) =>
      toast(err instanceof Error ? err.message : '썸네일을 변경하지 못했습니다.', 'error'),
  })

  const attachTag = useMutation({
    mutationFn: (payload: { tagId?: string; name?: string }) => api.attachTag(asset.id, payload),
    onSuccess: ({ asset: updated }) => {
      patchAssetInCaches(queryClient, updated)
      queryClient.invalidateQueries({ queryKey: ['tags'] })
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

  const deleteKeyRef = useRef(`${asset.id}:${crypto.randomUUID()}`)
  useEffect(() => {
    deleteKeyRef.current = `${asset.id}:${crypto.randomUUID()}`
  }, [asset.id])

  const destroyAsset = useMutation({
    mutationFn: async () => {
      const created = await api.createDeleteOperation(asset.id, deleteKeyRef.current)
      let current = created
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (current.state === 'completed') return current
        if (current.state === 'blocked' || current.state === 'cancelled_pre_commit') {
          throw new Error('삭제를 진행할 수 없습니다. 라이브러리 상태를 확인해 주세요.')
        }
        await new Promise((resolve) => window.setTimeout(resolve, 500))
        current = await api.getFileOperation(created.id)
      }
      return current
    },
    onSuccess: () => {
      setDeleteOpen(false)
      removeAssetFromCaches(queryClient, asset.id)
      toast('동영상을 영구 삭제했습니다.')
    },
    onError: (err) =>
      toast(err instanceof Error ? err.message : '영구 삭제하지 못했습니다.', 'error'),
  })

  useEffect(() => {
    setDeleteOpen(false)
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
                onPausedChange={setPaused}
              />
            </div>

            <h1 className="mt-4 text-[20px] font-semibold leading-snug text-white">
              {asset.filename}
            </h1>
            <p className="mt-1 text-[13px] text-white/55">{meta.join(' · ')}</p>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl bg-white/[0.04] px-3.5 py-2.5 text-[13px]">
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

            <div className="mt-3 flex flex-wrap items-center gap-2">
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
                disabled={!paused || capturePoster.isPending}
                onClick={() => capturePoster.mutate()}
                title={
                  paused
                    ? '일시정지된 현재 프레임을 썸네일로 저장합니다.'
                    : '재생 중에는 사용할 수 없습니다. 먼저 일시정지하세요.'
                }
                className={PILL}
              >
                <Camera size={16} />
                {capturePoster.isPending ? '저장 중...' : '이 부분을 썸네일로 쓰기'}
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

            <div className="mt-4 rounded-xl bg-white/[0.04] p-3.5">
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

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="동영상을 영구 삭제할까요?"
        description="이 작업은 되돌릴 수 없습니다. 원본 동영상 파일과 모든 관련 기록이 완전히 삭제됩니다."
        footer={
          <>
            <Button onClick={() => setDeleteOpen(false)}>취소</Button>
            <Button
              variant="danger"
              disabled={destroyAsset.isPending}
              onClick={() => destroyAsset.mutate()}
            >
              {destroyAsset.isPending ? '삭제 중...' : '영구 삭제'}
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-muted">
          <span className="font-medium text-ink">{asset.filename}</span> 파일과 썸네일, 자막, 태그,
          조회수, 누적 재생 시간, Vote 기록이 영구적으로 제거됩니다.
        </p>
      </Dialog>
    </div>
  )
}
