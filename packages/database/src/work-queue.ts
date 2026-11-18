import type { SQLQueryBindings } from 'bun:sqlite'
import type { EtaBasis, WorkPipeline } from '@mediavault/shared'
import type { Db } from './db'

type Params = SQLQueryBindings[]

const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const HISTORY_SAMPLES = 50
const MIN_SAMPLES = 3
const ITEM_LIMIT = 50
const FAILURE_LIMIT = 8

export interface WorkItemRecord {
  id: string
  pipeline: WorkPipeline
  kind: string
  assetId: string | null
  assetName: string | null
  state: 'running' | 'queued' | 'stalled' | 'failed'
  stage: string | null
  progress: number | null
  /** Null for media jobs, and for ASR and translation rows without a card. */
  onGpu: boolean | null
  startedAt: number | null
  updatedAt: number | null
  etaSeconds: number | null
  errorMessage: string | null
}

export interface WorkPipelineRecord {
  pipeline: WorkPipeline
  running: number
  queued: number
  stalled: number
  etaSeconds: number | null
  basis: EtaBasis
}

export interface WorkQueueRecord {
  generatedAt: number
  running: WorkItemRecord[]
  queued: WorkItemRecord[]
  stalled: WorkItemRecord[]
  remaining: number
  etaSeconds: number | null
  basis: EtaBasis
  pipelines: WorkPipelineRecord[]
  failures: WorkItemRecord[]
  lastCompletedAt: number | null
}

interface RawItem {
  id: string
  kind: string | null
  assetId: string | null
  assetName: string | null
  state: string
  stage: string | null
  progress: number | null
  onGpu: number | null
  startedAt: number | null
  updatedAt: number | null
  leaseExpiresAt: number | null
  errorMessage: string | null
}

interface CountRow {
  state: string
  n: number
}

function median(values: number[]): number | null {
  if (values.length < MIN_SAMPLES) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!
}

/**
 * Median time from claim to completion. Progress is not used for the estimate
 * because ASR reports it before it waits for the card, so a frozen percentage
 * would read as an ever-growing remainder.
 */
function history(db: Db, table: string, completed: string, now: number): number | null {
  const rows = db
    .query<{ duration: number }, Params>(
      `SELECT updated_at - started_at AS duration FROM ${table}
       WHERE state = ? AND started_at IS NOT NULL AND updated_at > ?
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(completed, now - HISTORY_WINDOW_MS, HISTORY_SAMPLES)
  return median(rows.map((row) => row.duration).filter((value) => value >= 1_000))
}

function pipelineEta(
  running: Array<{ startedAt: number | null }>,
  queued: number,
  averageMs: number | null,
  now: number,
): { etaSeconds: number | null; basis: EtaBasis } {
  if (running.length === 0 && queued === 0) return { etaSeconds: 0, basis: null }
  if (averageMs === null) return { etaSeconds: null, basis: null }

  let total = 0
  for (const item of running) {
    const elapsed = item.startedAt === null ? 0 : Math.max(0, now - item.startedAt)
    total += Math.max(0, averageMs - elapsed)
  }
  total += queued * averageMs
  return { etaSeconds: Math.round(total / 1000), basis: 'history' }
}

function counts(rows: CountRow[], runningStates: string[]): { running: number; queued: number } {
  let running = 0
  let queued = 0
  for (const row of rows) {
    if (row.state === 'queued') queued += row.n
    else if (runningStates.includes(row.state)) running += row.n
  }
  return { running, queued }
}

/** Every pipeline that has to wait for the card before it can report progress. */
function isGpuPipeline(pipeline: WorkPipeline): boolean {
  return pipeline !== 'media'
}

function pipelineOf(kind: string): WorkPipeline {
  return kind === 'asr' || kind === 'translation' || kind === 'embedding' ? kind : 'media'
}

/**
 * One read model over the three queues. Media runs beside the GPU work, while
 * ASR and translation share a card, so their estimates add up.
 */
export function workQueue(db: Db, now: number, gpuResource: string): WorkQueueRecord {
  const media = db
    .query<RawItem, Params>(
      `SELECT j.id, j.kind, j.asset_id AS assetId, a.filename AS assetName,
              j.state, j.phase AS stage,
              CASE WHEN j.progress_total > 0
                THEN MIN(100, CAST(ROUND((j.progress_current * 100.0) / j.progress_total) AS INTEGER))
                ELSE NULL END AS progress,
              NULL AS onGpu,
              j.started_at AS startedAt, j.updated_at AS updatedAt,
              j.lease_expires_at AS leaseExpiresAt, j.last_error AS errorMessage
       FROM jobs j LEFT JOIN assets a ON a.id = j.asset_id
       WHERE j.state IN ('queued','running')
       ORDER BY CASE j.state WHEN 'running' THEN 0 ELSE 1 END, j.priority ASC, j.id ASC
       LIMIT ?`,
    )
    .all(ITEM_LIMIT)

  const asr = db
    .query<RawItem, Params>(
      `SELECT j.id, 'asr' AS kind, j.asset_id AS assetId, a.filename AS assetName,
              j.state, j.stage, j.progress,
              CASE WHEN g.owner = j.lease_owner THEN 1 ELSE 0 END AS onGpu,
              j.started_at AS startedAt, j.updated_at AS updatedAt,
              j.lease_expires_at AS leaseExpiresAt, j.error_message AS errorMessage
       FROM asr_jobs j LEFT JOIN assets a ON a.id = j.asset_id
       LEFT JOIN gpu_leases g ON g.resource_id = ? AND g.released_at IS NULL
       WHERE j.state IN ('queued','transcribing','aligning','writing')
       ORDER BY CASE j.state WHEN 'queued' THEN 1 ELSE 0 END, j.created_at ASC
       LIMIT ?`,
    )
    .all(gpuResource, ITEM_LIMIT)

  const translation = db
    .query<RawItem, Params>(
      `SELECT j.id, 'translation' AS kind, j.asset_id AS assetId, a.filename AS assetName,
              j.state, j.stage, j.progress,
              CASE WHEN g.owner = j.lease_owner THEN 1 ELSE 0 END AS onGpu,
              j.started_at AS startedAt, j.updated_at AS updatedAt,
              j.lease_expires_at AS leaseExpiresAt, j.error_message AS errorMessage
       FROM translation_jobs j LEFT JOIN assets a ON a.id = j.asset_id
       LEFT JOIN gpu_leases g ON g.resource_id = ? AND g.released_at IS NULL
       WHERE j.state IN ('queued','translating','writing')
       ORDER BY CASE j.state WHEN 'queued' THEN 1 ELSE 0 END, j.created_at ASC
       LIMIT ?`,
    )
    .all(gpuResource, ITEM_LIMIT)

  const embedding = db
    .query<RawItem, Params>(
      `SELECT j.id, 'embedding' AS kind, j.asset_id AS assetId, a.filename AS assetName,
              j.state, j.stage, j.progress,
              CASE WHEN g.owner = j.lease_owner THEN 1 ELSE 0 END AS onGpu,
              j.started_at AS startedAt, j.updated_at AS updatedAt,
              j.lease_expires_at AS leaseExpiresAt, j.error_message AS errorMessage
       FROM embedding_jobs j LEFT JOIN assets a ON a.id = j.asset_id
       LEFT JOIN gpu_leases g ON g.resource_id = ? AND g.released_at IS NULL
       WHERE j.state IN ('queued','embedding','writing')
       ORDER BY CASE j.state WHEN 'queued' THEN 1 ELSE 0 END, j.created_at ASC
       LIMIT ?`,
    )
    .all(gpuResource, ITEM_LIMIT)

  const mediaCounts = counts(
    db
      .query<CountRow, []>(
        "SELECT state, COUNT(*) AS n FROM jobs WHERE state IN ('queued','running') GROUP BY state",
      )
      .all(),
    ['running'],
  )
  const asrCounts = counts(
    db
      .query<CountRow, []>(
        `SELECT state, COUNT(*) AS n FROM asr_jobs
         WHERE state IN ('queued','transcribing','aligning','writing') GROUP BY state`,
      )
      .all(),
    ['transcribing', 'aligning', 'writing'],
  )
  const translationCounts = counts(
    db
      .query<CountRow, []>(
        `SELECT state, COUNT(*) AS n FROM translation_jobs
         WHERE state IN ('queued','translating','writing') GROUP BY state`,
      )
      .all(),
    ['translating', 'writing'],
  )
  const embeddingCounts = counts(
    db
      .query<CountRow, []>(
        `SELECT state, COUNT(*) AS n FROM embedding_jobs
         WHERE state IN ('queued','embedding','writing') GROUP BY state`,
      )
      .all(),
    ['embedding', 'writing'],
  )
  const countsByPipeline: Record<WorkPipeline, { running: number; queued: number }> = {
    media: mediaCounts,
    asr: asrCounts,
    translation: translationCounts,
    embedding: embeddingCounts,
  }

  const toItem = (raw: RawItem, pipeline: WorkPipeline): WorkItemRecord => {
    const active =
      raw.state === 'running' ||
      raw.state === 'transcribing' ||
      raw.state === 'aligning' ||
      raw.state === 'translating' ||
      raw.state === 'embedding' ||
      raw.state === 'writing'
    const stalled =
      active && raw.leaseExpiresAt !== null && raw.leaseExpiresAt < now
    return {
      id: String(raw.id),
      pipeline,
      kind: raw.kind ?? pipeline,
      assetId: raw.assetId,
      assetName: raw.assetName,
      state:
        raw.state === 'failed'
          ? 'failed'
          : stalled
            ? 'stalled'
            : active
              ? 'running'
              : 'queued',
      stage: raw.stage,
      progress: pipeline === 'media' ? null : raw.progress,
      onGpu: pipeline === 'media' ? null : raw.onGpu === 1,
      startedAt: raw.startedAt,
      updatedAt: raw.updatedAt,
      etaSeconds: null,
      errorMessage: raw.errorMessage,
    }
  }

  const mediaItems = media.map((raw) => toItem(raw, 'media'))
  const asrItems = asr.map((raw) => toItem(raw, 'asr'))
  const translationItems = translation.map((raw) => toItem(raw, 'translation'))
  const embeddingItems = embedding.map((raw) => toItem(raw, 'embedding'))

  const averages: Record<WorkPipeline, number | null> = {
    media: history(db, 'jobs', 'done', now),
    asr: history(db, 'asr_jobs', 'completed', now),
    translation: history(db, 'translation_jobs', 'completed', now),
    embedding: history(db, 'embedding_jobs', 'completed', now),
  }

  const lanes: Array<{
    pipeline: WorkPipeline
    items: WorkItemRecord[]
  }> = [
    { pipeline: 'media', items: mediaItems },
    { pipeline: 'asr', items: asrItems },
    { pipeline: 'translation', items: translationItems },
    { pipeline: 'embedding', items: embeddingItems },
  ]

  const pipelines: WorkPipelineRecord[] = lanes.map((lane) => {
    const live = lane.items.filter((item) => item.state === 'running')
    const stalled = lane.items.filter((item) => item.state === 'stalled').length
    const { etaSeconds, basis } = pipelineEta(
      live,
      countsByPipeline[lane.pipeline].queued,
      averages[lane.pipeline],
      now,
    )
    return {
      pipeline: lane.pipeline,
      running: Math.max(0, countsByPipeline[lane.pipeline].running - stalled),
      queued: countsByPipeline[lane.pipeline].queued,
      stalled,
      etaSeconds: stalled > 0 ? null : etaSeconds,
      basis: stalled > 0 ? null : basis,
    }
  })

  for (const lane of lanes) {
    for (const item of lane.items) {
      if (item.state !== 'running') continue
      const average = averages[item.pipeline]
      if (average === null) continue
      const elapsed = item.startedAt === null ? 0 : Math.max(0, now - item.startedAt)
      item.etaSeconds = Math.max(0, Math.round((average - elapsed) / 1000))
    }
  }

  const laneOf = (pipeline: WorkPipeline) => pipelines.find((lane) => lane.pipeline === pipeline)!
  const mediaLane = laneOf('media')
  const gpuLanes = pipelines.filter((lane) => isGpuPipeline(lane.pipeline))

  // ASR, translation and embedding take turns on one card, so their estimates
  // add up. Media runs beside them, so the slower side decides the wall clock.
  const gpuEta = gpuLanes.some((lane) => lane.etaSeconds === null)
    ? null
    : gpuLanes.reduce((total, lane) => total + (lane.etaSeconds ?? 0), 0)
  const mediaBusy =
    countsByPipeline.media.running + countsByPipeline.media.queued > 0
  const gpuBusy = gpuLanes.some(
    (lane) => countsByPipeline[lane.pipeline].running + countsByPipeline[lane.pipeline].queued > 0,
  )

  const overall: number | null =
    !mediaBusy && !gpuBusy
      ? 0
      : (mediaBusy && mediaLane.etaSeconds === null) || (gpuBusy && gpuEta === null)
        ? null
        : Math.max(mediaBusy ? (mediaLane.etaSeconds ?? 0) : 0, gpuBusy ? (gpuEta ?? 0) : 0)

  const basis: EtaBasis =
    overall === null || (!mediaBusy && !gpuBusy) ? null : 'history'

  // A failure is live only when no newer attempt for the same work exists.
  // Retrying writes a newer row, so the older one is history, not a failure.
  const failures = db
    .query<RawItem, Params>(
      `SELECT * FROM (
         SELECT j.id, j.kind, j.asset_id AS assetId, a.filename AS assetName,
                j.state, NULL AS stage, NULL AS progress, NULL AS onGpu,
                j.started_at AS startedAt, j.updated_at AS updatedAt,
                NULL AS leaseExpiresAt, j.last_error AS errorMessage
         FROM jobs j LEFT JOIN assets a ON a.id = j.asset_id
         LEFT JOIN libraries l ON l.id = j.library_id
         WHERE j.state = 'failed' AND (j.library_id IS NULL OR l.id IS NOT NULL)
           AND NOT EXISTS (
             SELECT 1 FROM jobs n WHERE n.dedupe_key = j.dedupe_key AND n.updated_at > j.updated_at
           )
         UNION ALL
         SELECT j.id, 'asr', j.asset_id, a.filename, j.state, j.stage, j.progress,
                NULL, j.started_at, j.updated_at, NULL, j.error_message
         FROM asr_jobs j LEFT JOIN assets a ON a.id = j.asset_id
         WHERE j.state = 'failed' AND NOT EXISTS (
           SELECT 1 FROM asr_jobs n
           WHERE n.asset_id = j.asset_id AND n.file_version = j.file_version
             AND n.updated_at > j.updated_at
         )
         UNION ALL
         SELECT j.id, 'translation', j.asset_id, a.filename, j.state, j.stage, j.progress,
                NULL, j.started_at, j.updated_at, NULL, j.error_message
         FROM translation_jobs j LEFT JOIN assets a ON a.id = j.asset_id
         WHERE j.state = 'failed' AND NOT EXISTS (
           SELECT 1 FROM translation_jobs n
           WHERE n.asset_id = j.asset_id AND n.file_version = j.file_version
             AND n.target_language = j.target_language AND n.updated_at > j.updated_at
         )
         UNION ALL
         SELECT j.id, 'embedding', j.asset_id, a.filename, j.state, j.stage, j.progress,
                NULL, j.started_at, j.updated_at, NULL, j.error_message
         FROM embedding_jobs j LEFT JOIN assets a ON a.id = j.asset_id
         WHERE j.state = 'failed' AND NOT EXISTS (
           SELECT 1 FROM embedding_jobs n
           WHERE n.asset_id = j.asset_id AND n.file_version = j.file_version
             AND n.updated_at > j.updated_at
         )
       ) ORDER BY updatedAt DESC LIMIT ?`,
    )
    .all(FAILURE_LIMIT)

  const lastCompletedAt =
    db
      .query<{ last: number | null }, Params>(
        `SELECT MAX(finished) AS last FROM (
           SELECT MAX(updated_at) AS finished FROM jobs WHERE state = 'done'
           UNION ALL SELECT MAX(updated_at) FROM asr_jobs WHERE state = 'completed'
           UNION ALL SELECT MAX(updated_at) FROM translation_jobs WHERE state = 'completed'
           UNION ALL SELECT MAX(updated_at) FROM embedding_jobs WHERE state = 'completed'
         )`,
      )
      .get()?.last ?? null

  const all = [...mediaItems, ...asrItems, ...translationItems, ...embeddingItems]
  const running = all.filter((item) => item.state === 'running')
  const queued = all.filter((item) => item.state === 'queued')
  const stalled = all.filter((item) => item.state === 'stalled')

  return {
    generatedAt: now,
    running,
    queued,
    stalled,
    remaining: pipelines.reduce(
      (total, lane) => total + countsByPipeline[lane.pipeline].running + countsByPipeline[lane.pipeline].queued,
      0,
    ),
    etaSeconds: overall,
    basis,
    pipelines,
    failures: failures.map((raw) => toItem(raw, pipelineOf(raw.kind ?? 'media'))),
    lastCompletedAt,
  }
}
