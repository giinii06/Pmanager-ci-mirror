import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Cpu, Pause, Play, Square } from 'lucide-react'
import type {
  AsrStage,
  EmbeddingStage,
  JobDTO,
  SceneStage,
  TranslationStage,
  WorkItemDTO,
  WorkPipelineDTO,
  WorkQueueDTO,
} from '@mediavault/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { formatAgo, formatCount, formatEta } from '../lib/format'
import { useUi } from '../store/ui'
import {
  ASR_STAGE_LABEL,
  EMBEDDING_STAGE_LABEL,
  MUTATION_STAGE_LABEL,
  SCENE_STAGE_LABEL,
  TRANSLATION_STAGE_LABEL,
  kindLabel,
  pipelineLabel,
} from '../lib/stages'
import { Progress } from './ui/Progress'
import { Spinner } from './ui/Spinner'

function stageLabel(item: WorkItemDTO): string {
  if (item.pipeline === 'asr' && item.stage) {
    return ASR_STAGE_LABEL[item.stage as AsrStage] ?? kindLabel[item.kind]
  }
  if (item.pipeline === 'translation' && item.stage) {
    return TRANSLATION_STAGE_LABEL[item.stage as TranslationStage] ?? kindLabel[item.kind]
  }
  if (item.pipeline === 'embedding' && item.stage) {
    return EMBEDDING_STAGE_LABEL[item.stage as EmbeddingStage] ?? kindLabel[item.kind]
  }
  if (item.pipeline === 'scene' && item.stage) {
    return SCENE_STAGE_LABEL[item.stage as SceneStage] ?? kindLabel[item.kind]
  }
  if (item.pipeline === 'mutation' && item.stage) {
    return MUTATION_STAGE_LABEL[item.stage] ?? kindLabel[item.kind]
  }
  return kindLabel[item.kind]
}

function assetLabel(item: WorkItemDTO): string {
  return item.assetName ?? kindLabel[item.kind]
}

function itemEta(item: WorkItemDTO): string | null {
  if (item.etaSeconds === null || item.etaSeconds <= 0) return null
  return `약 ${formatEta(item.etaSeconds)} 남음`
}

/** Scene sampling is not chaptering: say how many windows of the file are read. */
function coverageLabel(item: WorkItemDTO): string | null {
  if (!item.coverage) return null
  return `${formatCount(item.coverage.analyzed)}/${formatCount(item.coverage.total)} 구간`
}

/** The API only claims a number when it has completion history behind it. */
function laneEta(lane: WorkPipelineDTO): { text: string; known: boolean } | null {
  if (lane.basis === 'history' && lane.etaSeconds !== null && lane.etaSeconds > 0) {
    return { text: `약 ${formatEta(lane.etaSeconds)}`, known: true }
  }
  if (lane.basis === 'insufficient_data') return { text: '기록 부족', known: false }
  if (lane.running > 0) return { text: '계산 중', known: false }
  if (lane.queued > 0 || lane.stalled > 0) return { text: '미정', known: false }
  return null
}

function overallEta(queue: WorkQueueDTO): { text: string; known: boolean } {
  if (queue.basis === 'history' && queue.etaSeconds !== null && queue.etaSeconds > 0) {
    return { text: `약 ${formatEta(queue.etaSeconds)} 남음`, known: true }
  }
  const running = queue.running.length > 0
  return running
    ? { text: '남은 시간 계산 중', known: false }
    : { text: '남은 시간 미정', known: false }
}

function GpuBadge({ onGpu, waiting }: { onGpu: boolean | null; waiting: boolean }) {
  if (onGpu === null) return null
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10.5px]',
        waiting ? 'border-line text-faint' : 'border-line-strong text-muted',
      )}
    >
      <Cpu size={10} />
      {waiting ? 'GPU 대기 중' : 'GPU 사용 중'}
    </span>
  )
}

function RunningHero({ item }: { item: WorkItemDTO }) {
  const waiting = item.waitingGpu
  const eta = itemEta(item)
  const coverage = coverageLabel(item)

  return (
    <div className="px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p
            className={cn(
              'truncate text-[13.5px] font-medium',
              waiting ? 'text-muted' : 'text-ink',
            )}
          >
            {assetLabel(item)}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-muted">
            <span>{pipelineLabel[item.pipeline]}</span>
            <span className="text-faint">·</span>
            <span>{stageLabel(item)}</span>
            {coverage ? (
              <>
                <span className="text-faint">·</span>
                <span>{coverage}</span>
              </>
            ) : null}
            {item.startedAt ? (
              <>
                <span className="text-faint">·</span>
                <span>{formatAgo(item.startedAt)} 시작</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <GpuBadge onGpu={item.onGpu} waiting={item.waitingGpu} />
          {item.progress !== null ? (
            <span className="text-[15px] font-semibold tabular-nums text-ink">
              {item.progress}%
            </span>
          ) : null}
        </div>
      </div>

      <Progress
        className="mt-3"
        value={item.progress}
        size="hero"
        tone={waiting ? 'muted' : 'accent'}
        label={`${assetLabel(item)} ${stageLabel(item)}`}
      />

      {eta ? <p className="mt-2 text-right text-[11.5px] text-faint">{eta}</p> : null}
    </div>
  )
}

function RunningRow({ item }: { item: WorkItemDTO }) {
  const waiting = item.waitingGpu
  const eta = itemEta(item)
  const coverage = coverageLabel(item)

  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[12px]',
            waiting ? 'text-muted' : 'text-ink',
          )}
        >
          {assetLabel(item)}
        </span>
        <span className="shrink-0 text-[11px] text-muted">{stageLabel(item)}</span>
        {coverage ? <span className="shrink-0 text-[11px] text-faint">{coverage}</span> : null}
        <GpuBadge onGpu={item.onGpu} waiting={item.waitingGpu} />
        {item.progress !== null ? (
          <span className="shrink-0 text-[12px] tabular-nums text-ink">{item.progress}%</span>
        ) : null}
      </div>
      <Progress
        className="mt-1.5"
        value={item.progress}
        tone={waiting ? 'muted' : 'accent'}
        label={`${assetLabel(item)} ${stageLabel(item)}`}
      />
      {eta ? <p className="mt-1 text-right text-[11px] text-faint">{eta}</p> : null}
    </div>
  )
}

function StalledRow({ item }: { item: WorkItemDTO }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
      <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{assetLabel(item)}</span>
      <span className="shrink-0 text-[11px] text-faint">{pipelineLabel[item.pipeline]}</span>
      <span className="shrink-0 rounded-full border border-danger/35 bg-danger/10 px-1.5 py-0.5 text-[10.5px] text-danger">
        응답 없음
      </span>
    </div>
  )
}

function LaneCounts({ lane }: { lane: WorkPipelineDTO }) {
  const parts: { text: string; danger?: boolean }[] = []
  if (lane.running > 0) parts.push({ text: `처리 중 ${formatCount(lane.running)}` })
  if (lane.waitingGpu > 0) parts.push({ text: `GPU 대기 ${formatCount(lane.waitingGpu)}` })
  if (lane.queued > 0) parts.push({ text: `대기 ${formatCount(lane.queued)}` })
  if (lane.stalled > 0) parts.push({ text: `응답 없음 ${formatCount(lane.stalled)}`, danger: true })

  return (
    <span className="flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-muted">
      {parts.map((part, index) => (
        <span key={part.text} className="flex items-center gap-1.5">
          {index > 0 ? <span className="text-faint">·</span> : null}
          <span className={part.danger ? 'text-danger' : undefined}>{part.text}</span>
        </span>
      ))}
    </span>
  )
}

function LaneRow({ lane }: { lane: WorkPipelineDTO }) {
  const eta = laneEta(lane)

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2">
      <span className="w-16 shrink-0 text-[12px] text-ink">{pipelineLabel[lane.pipeline]}</span>
      <LaneCounts lane={lane} />
      {eta ? (
        <span
          className={cn(
            'ml-auto shrink-0 text-[11.5px] tabular-nums',
            eta.known ? 'text-ink' : 'text-faint',
          )}
        >
          {eta.text}
        </span>
      ) : null}
    </div>
  )
}

function FailureStrip({ failures }: { failures: WorkItemDTO[] }) {
  if (failures.length === 0) return null

  return (
    <div className="border-t border-line px-4 py-3">
      <p className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.08em] text-faint">
        <AlertTriangle size={11} className="text-danger" />
        최근 실패
      </p>
      <div className="mt-1.5 space-y-1">
        {failures.slice(0, 2).map((item) => (
          <p
            key={item.id}
            className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[11.5px]"
          >
            <span className="shrink-0 text-ink">「{assetLabel(item)}」</span>
            {item.errorCode ? (
              <span
                className="shrink-0 rounded border border-line px-1 font-mono text-[10px] text-faint"
                title={item.errorCode}
              >
                {item.errorCode}
              </span>
            ) : null}
            <span
              className="min-w-0 flex-1 truncate text-muted"
              title={item.errorMessage ?? undefined}
            >
              {item.errorMessage ?? '알 수 없는 오류입니다.'}
            </span>
          </p>
        ))}
      </div>
    </div>
  )
}

function EmptyState({ lastCompletedAt }: { lastCompletedAt: string | null }) {
  return (
    <div className="px-4 py-8 text-center">
      <p className="text-[13px] text-muted">대기 중인 작업이 없습니다</p>
      {lastCompletedAt ? (
        <p className="mt-1 text-[11.5px] text-faint">
          마지막 작업 {formatAgo(lastCompletedAt)} 완료
        </p>
      ) : null}
    </div>
  )
}

function JobControlRow({
  job,
  pending,
  onPause,
  onResume,
  onCancel,
}: {
  job: JobDTO
  pending: boolean
  onPause: (id: number) => void
  onResume: (id: number) => void
  onCancel: (id: number) => void
}) {
  const canPause = job.state === 'running' || job.state === 'queued'
  const canResume = job.state === 'paused'
  const canCancel = job.state === 'running' || job.state === 'queued' || job.state === 'paused'
  const progressText =
    job.progressTotal && job.progressTotal > 0
      ? `${formatCount(job.progressCurrent)} / ${formatCount(job.progressTotal)}`
      : job.progressCurrent > 0
        ? `${formatCount(job.progressCurrent)}개`
        : null

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-[12px]">
      <span className="font-medium text-ink">{kindLabel[job.kind]}</span>
      {job.phase ? <span className="text-muted">{job.phase}</span> : null}
      {progressText ? <span className="tabular-nums text-faint">{progressText}</span> : null}
      <span
        className={cn(
          'rounded-full border px-1.5 py-0.5 text-[10.5px] font-medium',
          job.state === 'paused'
            ? 'border-accent/40 bg-accent/12 text-accent'
            : job.state === 'running'
              ? 'border-[#34d399]/35 bg-[#34d399]/10 text-[#34d399]'
              : 'border-line text-muted',
        )}
      >
        {job.pauseRequested
          ? '일시정지 요청됨'
          : job.cancelRequested
            ? '취소 요청됨'
            : job.state === 'paused'
              ? '일시정지됨'
              : job.state === 'running'
                ? '실행 중'
                : '대기 중'}
      </span>
      <div className="ml-auto flex items-center gap-1">
        {canPause ? (
          <button
            type="button"
            disabled={pending || job.pauseRequested}
            onClick={() => onPause(job.id)}
            className="inline-flex items-center gap-1 rounded-md border border-line bg-panel-2 px-2 py-1 text-[11px] text-ink hover:border-line-strong disabled:opacity-45"
          >
            <Pause size={10} />
            일시정지
          </button>
        ) : null}
        {canResume ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => onResume(job.id)}
            className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/15 px-2 py-1 text-[11px] text-accent hover:bg-accent/25 disabled:opacity-45"
          >
            <Play size={10} />
            재개
          </button>
        ) : null}
        {canCancel ? (
          <button
            type="button"
            disabled={pending || job.cancelRequested}
            onClick={() => onCancel(job.id)}
            className="inline-flex items-center gap-1 rounded-md border border-danger/35 bg-danger/10 px-2 py-1 text-[11px] text-danger hover:bg-danger/20 disabled:opacity-45"
          >
            <Square size={10} />
            취소
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function ProcessingPanel() {
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const queue = useQuery({
    queryKey: ['work-queue'],
    queryFn: api.workQueue,
    refetchInterval: (query) => ((query.state.data?.remaining ?? 0) > 0 ? 2000 : 15_000),
  })
  const jobs = useQuery({
    queryKey: ['jobs'],
    queryFn: api.jobs,
    refetchInterval: (query) => {
      const counts = query.state.data?.counts
      return (counts?.running ?? 0) + (counts?.queued ?? 0) + (counts?.paused ?? 0) > 0 ? 2500 : 15_000
    },
  })

  const invalidateJobs = () => {
    queryClient.invalidateQueries({ queryKey: ['jobs'] })
    queryClient.invalidateQueries({ queryKey: ['work-queue'] })
    queryClient.invalidateQueries({ queryKey: ['libraries'] })
  }

  const control = useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'pause' | 'resume' | 'cancel' }) =>
      action === 'pause'
        ? api.pauseJob(id)
        : action === 'resume'
          ? api.resumeJob(id)
          : api.cancelJob(id),
    onSuccess: () => invalidateJobs(),
    onError: (err) => toast(err instanceof Error ? err.message : '작업을 제어하지 못했습니다.', 'error'),
  })

  const data = queue.data
  const activeList = jobs.data?.active ?? []
  const hero = data && data.running.length === 1 ? (data.running[0] ?? null) : null
  const runningTotal = data?.pipelines.reduce((sum, lane) => sum + lane.running, 0) ?? 0
  const hasWork = Boolean(
    (data && (data.remaining > 0 || data.running.length > 0 || data.stalled.length > 0)) ||
      activeList.length > 0,
  )
  const lanes =
    data?.pipelines.filter((lane) => lane.running + lane.queued + lane.stalled > 0) ?? []
  const eta = data ? overallEta(data) : null

  return (
    <section className="mb-6 overflow-hidden rounded-panel border border-line bg-panel">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-[13.5px] font-semibold text-ink">처리 현황</h2>
        <p className="mt-0.5 text-[11.5px] text-muted">
          지금 처리 중인 작업과 남은 시간을 최근 처리 기록으로 계산합니다.
        </p>
      </div>

      {queue.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : queue.isError ? (
        <p className="px-4 py-6 text-[12px] text-muted">
          {queue.error instanceof Error ? queue.error.message : '처리 현황을 불러오지 못했습니다.'}
        </p>
      ) : !data ? null : !hasWork ? (
        <EmptyState lastCompletedAt={data.lastCompletedAt} />
      ) : (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-2.5">
            <p className="text-[12px] text-muted">
              남은 작업{' '}
              <span className="font-medium tabular-nums text-ink">
                {formatCount(data.remaining)}
              </span>
              개
            </p>
            {eta ? (
              <p
                className={cn(
                  'tabular-nums',
                  eta.known ? 'text-[13px] font-medium text-ink' : 'text-[12px] text-muted',
                )}
              >
                {eta.text}
              </p>
            ) : null}
          </div>

          {hero ? (
            <RunningHero item={hero} />
          ) : data.running.length > 1 ? (
            <div className="divide-y divide-line/60">
              <p className="px-4 pb-1.5 pt-3 text-[11.5px] text-muted">
                {formatCount(runningTotal)}개 작업이 동시에 진행 중입니다
              </p>
              {data.running.map((item) => (
                <RunningRow key={item.id} item={item} />
              ))}
            </div>
          ) : null}

          {data.stalled.length > 0 ? (
            <div className="divide-y divide-line/60 border-t border-line/60">
              {data.stalled.map((item) => (
                <StalledRow key={item.id} item={item} />
              ))}
            </div>
          ) : null}

          {lanes.length > 0 ? (
            <div className="divide-y divide-line/60 border-t border-line">
              <p className="px-4 pb-1 pt-3 text-[10.5px] uppercase tracking-[0.08em] text-faint">
                파이프라인별 남은 작업
              </p>
              {lanes.map((lane) => (
                <LaneRow key={lane.pipeline} lane={lane} />
              ))}
            </div>
          ) : null}

          {activeList.length > 0 ? (
            <div className="divide-y divide-line/60 border-t border-line">
              <p className="px-4 pb-1 pt-3 text-[10.5px] uppercase tracking-[0.08em] text-faint">
                백그라운드 작업 제어 ({formatCount(activeList.length)}개)
              </p>
              {activeList.slice(0, 8).map((job) => (
                <JobControlRow
                  key={job.id}
                  job={job}
                  pending={control.isPending}
                  onPause={(id) => control.mutate({ id, action: 'pause' })}
                  onResume={(id) => control.mutate({ id, action: 'resume' })}
                  onCancel={(id) => control.mutate({ id, action: 'cancel' })}
                />
              ))}
            </div>
          ) : null}

          <FailureStrip failures={data.failures} />
        </>
      )}
    </section>
  )
}
