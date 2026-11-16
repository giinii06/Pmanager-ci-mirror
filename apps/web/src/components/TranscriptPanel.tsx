import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Search, Sparkles, X } from 'lucide-react'
import type {
  AssetDTO,
  SubtitleTrackDTO,
  TranscriptSegmentDTO,
} from '@mediavault/shared'
import { api, ApiError } from '../lib/api'
import { cn } from '../lib/cn'
import { ASR_STAGE_LABEL, TRANSLATION_STAGE_LABEL } from '../lib/stages'
import { Spinner } from './ui/Spinner'
import { languageName } from './SubtitleMenu'

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function isActive(state: string | undefined): boolean {
  return state === 'queued' || state === 'transcribing' || state === 'aligning' || state === 'writing'
}

function isTranslationActive(state: string | undefined): boolean {
  return state === 'queued' || state === 'translating' || state === 'writing'
}

function JobProgress({
  label,
  progress,
  note,
}: {
  label: string
  progress: number
  note: string
}) {
  return (
    <div className="px-4 py-5">
      <div className="flex items-center gap-2 text-[12.5px] text-ink">
        <Spinner className="text-accent" />
        <span>{label}</span>
        <span className="ml-auto tabular-nums text-muted">{progress}%</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-faint">{note}</p>
    </div>
  )
}

export function TranscriptPanel({
  asset,
  tracks,
  language,
  videoRef,
  onClose,
}: {
  asset: AssetDTO
  tracks: SubtitleTrackDTO[]
  language: string | null
  videoRef: RefObject<HTMLVideoElement | null>
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [tab, setTab] = useState<string | null>(language)

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

  const ready = Boolean(status.data?.transcript)

  const transcript = useQuery({
    queryKey: ['transcript', asset.id],
    queryFn: () => api.transcript(asset.id),
    enabled: ready,
    staleTime: 60_000,
  })

  const sourceLanguage =
    transcript.data?.language ?? tracks.find((track) => track.source === 'asr')?.language ?? null
  const target = tracks.find((track) => track.source === 'translation')?.language ?? null

  const tabs = useMemo(() => {
    const list: string[] = []
    if (sourceLanguage) list.push(sourceLanguage)
    if (target && target !== sourceLanguage) list.push(target)
    return list
  }, [sourceLanguage, target])

  const activeTab = tab && tabs.includes(tab) ? tab : (sourceLanguage ?? target)
  const onTranslationTab = Boolean(target) && activeTab === target

  const translationStatus = useQuery({
    queryKey: ['translation-status', asset.id, target],
    queryFn: () => api.translationStatus(asset.id, target!),
    enabled: ready && Boolean(target),
    refetchInterval: (result) =>
      isTranslationActive(result.state.data?.job?.state) ? 2000 : false,
  })

  const translationReady = Boolean(translationStatus.data?.translation)

  const translation = useQuery({
    queryKey: ['translation', asset.id, target],
    queryFn: () => api.translation(asset.id, target!),
    enabled: translationReady,
    staleTime: 60_000,
  })

  const search = useQuery({
    queryKey: ['transcript-search', asset.id, activeTab, debounced],
    queryFn: () => api.searchTranscript(asset.id, debounced, activeTab ?? undefined),
    enabled:
      debounced.length > 0 &&
      Boolean(activeTab) &&
      (onTranslationTab ? translationReady : ready),
  })

  const create = useMutation({
    mutationFn: (force: boolean) => api.createTranscription(asset.id, force),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['transcription', asset.id] })
      void queryClient.invalidateQueries({ queryKey: ['transcript', asset.id] })
    },
  })

  const createTranslation = useMutation({
    mutationFn: (force: boolean) => api.createTranslation(asset.id, target ?? undefined, force),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['translation-status', asset.id, target] })
    },
  })

  // The player reads subtitle-tracks, so a transcript or translation that lands
  // while this panel is open has to push the new track list to it.
  const announced = useRef<{ transcript: boolean | null; translation: boolean | null }>({
    transcript: null,
    translation: null,
  })
  useEffect(() => {
    const previous = announced.current
    const transcriptLanded = previous.transcript === false && ready
    const translationLanded = previous.translation === false && translationReady
    announced.current = { transcript: ready, translation: translationReady }
    if (transcriptLanded || translationLanded) {
      void queryClient.invalidateQueries({ queryKey: ['subtitle-tracks', asset.id] })
    }
    if (translationLanded) {
      void queryClient.invalidateQueries({ queryKey: ['translation', asset.id, target] })
    }
  }, [asset.id, queryClient, ready, target, translationReady])

  const segments: TranscriptSegmentDTO[] = useMemo(() => {
    if (debounced.length > 0 && search.data) return search.data.hits
    if (onTranslationTab) return translation.data?.segments ?? []
    return transcript.data?.segments ?? []
  }, [debounced, search.data, transcript.data, translation.data, onTranslationTab])

  const seek = (startMs: number) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = startMs / 1000
    void video.play().catch(() => undefined)
  }

  const job = status.data?.job
  const running = isActive(job?.state)
  const noSpeech = status.data?.transcript?.hasSpeech === false
  const failed = job?.state === 'failed'
  const translationJob = translationStatus.data?.job
  const translationRunning = isTranslationActive(translationJob?.state)
  const translationFailed = translationJob?.state === 'failed'
  const targetName = target ? languageName(target) : '번역'

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
          <JobProgress
            label={ASR_STAGE_LABEL[job?.stage ?? 'queued']}
            progress={job?.progress ?? 0}
            note="음성 인식과 시간 정렬은 한 번에 하나씩 실행됩니다. 창을 닫아도 작업은 계속됩니다."
          />
        ) : noSpeech ? (
          <div className="px-4 py-5">
            <p className="text-[12.5px] text-ink">이 파일에는 대사가 없습니다.</p>
            <p className="mt-1.5 break-words text-[11.5px] leading-relaxed text-muted">
              자막은 말소리가 있는 파일에만 만듭니다. 다시 확인하면 이 파일을 한 번 더 인식합니다.
            </p>
            <button
              type="button"
              onClick={() => create.mutate(true)}
              disabled={create.isPending}
              className="mt-3 rounded-lg border border-line-strong px-3 py-1.5 text-[12px] text-muted transition-colors hover:bg-raised hover:text-ink disabled:opacity-50"
            >
              다시 확인
            </button>
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
            {tabs.length > 1 ? (
              <div className="flex items-center gap-1 border-b border-white/10 px-3 py-2">
                {tabs.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    aria-pressed={tag === activeTab}
                    onClick={() => setTab(tag)}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-[12px] transition-colors',
                      tag === activeTab
                        ? 'bg-white/10 text-ink'
                        : 'text-muted hover:bg-white/5 hover:text-ink',
                    )}
                  >
                    {languageName(tag)}
                  </button>
                ))}
              </div>
            ) : null}

            {onTranslationTab && !translationReady ? (
              translationRunning ? (
                <JobProgress
                  label={TRANSLATION_STAGE_LABEL[translationJob?.stage ?? 'queued']}
                  progress={translationJob?.progress ?? 0}
                  note="번역은 자막 문장 단위로 진행됩니다. 창을 닫아도 작업은 계속됩니다."
                />
              ) : translationFailed ? (
                <div className="px-4 py-5">
                  <p className="text-[12.5px] text-ink">{targetName} 번역을 만들지 못했습니다.</p>
                  <p className="mt-1.5 break-words text-[11.5px] leading-relaxed text-muted">
                    {translationJob?.errorMessage ?? '알 수 없는 오류입니다.'}
                  </p>
                  <button
                    type="button"
                    onClick={() => createTranslation.mutate(true)}
                    disabled={createTranslation.isPending}
                    className="mt-3 rounded-lg border border-line-strong px-3 py-1.5 text-[12px] text-ink transition-colors hover:bg-raised disabled:opacity-50"
                  >
                    다시 시도
                  </button>
                </div>
              ) : (
                <div className="px-4 py-5">
                  <p className="text-[12.5px] leading-relaxed text-muted">
                    원본 자막을 {targetName}로 번역해 시간 정보가 있는 자막을 만듭니다. 원본 자막은
                    그대로 남습니다.
                  </p>
                  <button
                    type="button"
                    onClick={() => createTranslation.mutate(false)}
                    disabled={createTranslation.isPending}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {createTranslation.isPending ? (
                      <Spinner className="text-black" />
                    ) : (
                      <Sparkles size={13} />
                    )}
                    {targetName} 번역
                  </button>
                  {createTranslation.error ? (
                    <p className="mt-2 text-[11.5px] text-muted">
                      {createTranslation.error instanceof ApiError
                        ? createTranslation.error.message
                        : '요청을 보내지 못했습니다.'}
                    </p>
                  ) : null}
                </div>
              )
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
                        href={api.vttUrl(asset.id, asset.fileVersion, activeTab ?? undefined)}
                        className="inline-flex items-center gap-1 transition-colors hover:text-ink"
                      >
                        <Download size={11} /> VTT
                      </a>
                      <a
                        href={api.srtUrl(asset.id, asset.fileVersion, activeTab ?? undefined)}
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
                        <span className="text-[12.5px] leading-relaxed text-ink">
                          {segment.text}
                        </span>
                      </button>
                    ))
                  )}
                </div>

                {!onTranslationTab ? (
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
                ) : null}
              </>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
