import { useEffect, useMemo, useState, type RefObject } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Search, Sparkles, X } from 'lucide-react'
import type { AssetDTO, AsrStage, TranscriptSegmentDTO } from '@mediavault/shared'
import { api, ApiError } from '../lib/api'
import { cn } from '../lib/cn'
import { Spinner } from './ui/Spinner'

const STAGE_LABEL: Record<AsrStage, string> = {
  queued: '대기 중',
  extracting: '오디오 추출 중',
  chunking: '음성 구간 분석 중',
  transcribing: '음성 인식 중',
  aligning: '시간 정렬 중',
  writing: '자막 저장 중',
  completed: '완료',
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function isActive(state: string | undefined): boolean {
  return state === 'queued' || state === 'transcribing' || state === 'aligning' || state === 'writing'
}

export function TranscriptPanel({
  asset,
  videoRef,
  onClose,
}: {
  asset: AssetDTO
  videoRef: RefObject<HTMLVideoElement | null>
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    setQuery('')
    setDebounced('')
  }, [asset.id])

  const status = useQuery({
    queryKey: ['transcription', asset.id],
    queryFn: () => api.transcriptionStatus(asset.id),
    refetchInterval: (result) =>
      isActive(result.state.data?.job?.state) ? 2000 : false,
  })

  const transcript = useQuery({
    queryKey: ['transcript', asset.id],
    queryFn: () => api.transcript(asset.id),
    enabled: Boolean(status.data?.transcript),
    staleTime: 60_000,
  })

  const search = useQuery({
    queryKey: ['transcript-search', asset.id, debounced],
    queryFn: () => api.searchTranscript(asset.id, debounced),
    enabled: debounced.length > 0 && Boolean(status.data?.transcript),
  })

  const create = useMutation({
    mutationFn: (force: boolean) => api.createTranscription(asset.id, force),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['transcription', asset.id] })
      void queryClient.invalidateQueries({ queryKey: ['transcript', asset.id] })
    },
  })

  const segments: TranscriptSegmentDTO[] = useMemo(() => {
    if (debounced.length > 0 && search.data) return search.data.hits
    return transcript.data?.segments ?? []
  }, [debounced, search.data, transcript.data])

  const seek = (startMs: number) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = startMs / 1000
    void video.play().catch(() => undefined)
  }

  const job = status.data?.job
  const running = isActive(job?.state)
  const failed = job?.state === 'failed'
  const ready = Boolean(status.data?.transcript)

  return (
    <aside className="flex h-full w-full flex-col border-l border-white/10 bg-[#0b0c0f]/97">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-accent" />
          <h3 className="text-[13px] font-semibold text-ink">AI 자막</h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="자막 닫기"
          className="rounded-full p-1.5 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
        >
          <X size={15} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {!status.data?.available ? (
          <p className="px-4 py-6 text-[12.5px] leading-relaxed text-muted">
            이 서버에는 자막 생성기가 설정되어 있지 않습니다. 운영 문서의 ASR 설정을 먼저 적용하세요.
          </p>
        ) : running ? (
          <div className="px-4 py-5">
            <div className="flex items-center gap-2 text-[12.5px] text-ink">
              <Spinner className="text-accent" />
              <span>{STAGE_LABEL[job?.stage ?? 'queued']}</span>
              <span className="ml-auto tabular-nums text-muted">{job?.progress ?? 0}%</span>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-500"
                style={{ width: `${job?.progress ?? 0}%` }}
              />
            </div>
            <p className="mt-3 text-[11.5px] leading-relaxed text-faint">
              음성 인식과 시간 정렬은 한 번에 하나씩 실행됩니다. 창을 닫아도 작업은 계속됩니다.
            </p>
          </div>
        ) : failed ? (
          <div className="px-4 py-5">
            <p className="text-[12.5px] text-ink">자막을 만들지 못했습니다.</p>
            <p className="mt-1.5 break-words text-[11.5px] leading-relaxed text-muted">
              {job?.errorMessage ?? '알 수 없는 오류입니다.'}
            </p>
            <button
              type="button"
              onClick={() => create.mutate(true)}
              disabled={create.isPending}
              className="mt-3 rounded-lg border border-line-strong px-3 py-1.5 text-[12px] text-ink transition-colors hover:bg-raised disabled:opacity-50"
            >
              다시 시도
            </button>
          </div>
        ) : !ready ? (
          <div className="px-4 py-5">
            <p className="text-[12.5px] leading-relaxed text-muted">
              한국어 음성을 인식해 시간 정보가 있는 자막을 만듭니다. 영상 길이에 따라 몇 분이 걸릴 수
              있습니다.
            </p>
            <button
              type="button"
              onClick={() => create.mutate(false)}
              disabled={create.isPending}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {create.isPending ? <Spinner className="text-black" /> : <Sparkles size={13} />}
              AI 자막 생성
            </button>
            {create.error ? (
              <p className="mt-2 text-[11.5px] text-muted">
                {create.error instanceof ApiError
                  ? create.error.message
                  : '요청을 보내지 못했습니다.'}
              </p>
            ) : null}
          </div>
        ) : (
          <>
            <div className="border-b border-white/10 px-4 py-2.5">
              <label className="flex items-center gap-2 rounded-lg bg-white/5 px-2.5 py-1.5">
                <Search size={13} className="shrink-0 text-faint" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="자막에서 찾기"
                  className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-faint"
                />
                {search.isFetching ? <Spinner className="text-faint" /> : null}
              </label>
              <div className="mt-2 flex items-center gap-2 text-[11.5px] text-faint">
                <span className="tabular-nums">
                  {debounced ? `${segments.length}개 일치` : `${segments.length}문장`}
                </span>
                <span className="ml-auto flex items-center gap-2">
                  <a
                    href={api.vttUrl(asset.id, asset.fileVersion)}
                    className="inline-flex items-center gap-1 transition-colors hover:text-ink"
                  >
                    <Download size={11} /> VTT
                  </a>
                  <a
                    href={api.srtUrl(asset.id, asset.fileVersion)}
                    className="inline-flex items-center gap-1 transition-colors hover:text-ink"
                  >
                    <Download size={11} /> SRT
                  </a>
                </span>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {segments.length === 0 ? (
                <p className="px-2 py-4 text-[12px] text-muted">
                  {debounced ? '일치하는 문장이 없습니다.' : '자막 문장이 없습니다.'}
                </p>
              ) : (
                segments.map((segment) => (
                  <button
                    key={`${segment.seq}-${segment.startMs}`}
                    type="button"
                    onClick={() => seek(segment.startMs)}
                    className={cn(
                      'flex w-full gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors',
                      'hover:bg-white/8 focus-visible:bg-white/8 focus-visible:outline-none',
                    )}
                  >
                    <span className="mt-0.5 shrink-0 tabular-nums text-[11px] text-faint">
                      {clock(segment.startMs)}
                    </span>
                    <span className="text-[12.5px] leading-relaxed text-ink">{segment.text}</span>
                  </button>
                ))
              )}
            </div>

            <div className="border-t border-white/10 px-4 py-2.5">
              <button
                type="button"
                onClick={() => create.mutate(true)}
                disabled={create.isPending}
                className="text-[11.5px] text-faint transition-colors hover:text-ink disabled:opacity-50"
              >
                자막 다시 만들기
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
