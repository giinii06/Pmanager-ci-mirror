import type { SQLQueryBindings } from 'bun:sqlite'
import {
  parseJobError,
  type EtaBasis,
  type SceneCoverage,
  type WorkPipeline,
} from '@mediavault/shared'
import type { Db } from './db'

type Params = SQLQueryBindings[]

const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const HISTORY_SAMPLES = 50
const MIN_SAMPLES = 3
const ITEM_LIMIT = 50
const FAILURE_LIMIT = 8

export const WORK_PIPELINES: WorkPipeline[] = [
  'media',
  'asr',
  'translation',
  'embedding',
  'scene',
  'mutation',
  'backup',
  'maintenance',
  'bulk',
]

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
  /** True while a running GPU job has not taken the card yet. */
  waitingGpu: boolean
  /** Scene sampling against a full-coverage plan; null for every other lane. */
  coverage: SceneCoverage | null
  startedAt: number | null
  updatedAt: number | null
  etaSeconds: number | null
  /** Standard `JOB_ERROR_CODES` for media jobs, the mutation engine's own code otherwise. */
  errorCode: string | null
  errorMessage: string | null
}

export interface WorkPipelineRecord {
  pipeline: WorkPipeline
  running: number
  queued: number
  stalled: number
  runningGpu: number
  waitingGpu: number
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
  errorCode: string | null
  durationMs?: number | null
  windowMs?: number
  overlapMs?: number
}

interface CountRow {
  state: string
  n: number
}

/** Active rows count as running; terminal failure rows feed the failure strip. */
const LANE_STATES: Record<WorkPipeline, { active: string[]; failed: string[] }> = {
  media: { active: ['running'], failed: ['failed'] },
  asr: { active: ['transcribing', 'aligning', 'writing'], failed: ['failed'] },
  translation: { active: ['translating', 'writing'], failed: ['failed'] },
  embedding: { active: ['embedding', 'writing'], failed: ['failed'] },
  scene: { active: ['extracting', 'embedding', 'writing'], failed: ['failed'] },
  mutation: {
    active: ['requested', 'validated', 'quarantined', 'db_committed', 'purging'],
    failed: ['failed_retryable', 'blocked'],
  },
  backup: { active: [], failed: [] },
  maintenance: { active: ['running'], failed: ['failed'] },
  bulk: { active: ['queued', 'running', 'cancelling'], failed: ['failed'] },
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
 * Mirrors `plan_windows` in apps/scene-worker/src/scene_worker/stage.py. A
 * positive cap widens the step so one job analyses at most that many windows,
 * sampling the file instead of covering it. Change both copies together.
 */
export function sceneWindowCount(
  durationMs: number,
  windowMs: number,
  overlapMs: number,
  maxWindows = 0,
): number {
  if (durationMs <= 0 || windowMs <= 0) return 0
  let step = Math.max(1, windowMs - overlapMs)
  if (maxWindows > 0 && durationMs > step * maxWindows) {
    step = Math.max(1, Math.ceil(durationMs / maxWindows))
  }
  let count = 0
  let start = 0
  while (start < durationMs) {
    const end = Math.min(start + windowMs, durationMs)
    count += 1
    if (end >= durationMs) break
    start += step
  }
  return count
}

/** Sampled windows against the uncapped plan, or null without a duration. */
export function sceneCoverage(
  durationMs: number | null | undefined,
  windowMs: number,
  overlapMs: number,
  maxWindows: number,
): SceneCoverage | null {
  if (!durationMs || durationMs <= 0 || windowMs <= 0) return null
  const analyzed = sceneWindowCount(durationMs, windowMs, overlapMs, maxWindows)
  const total = sceneWindowCount(durationMs, windowMs, overlapMs, 0)
  return { analyzed, total, sampled: analyzed < total }
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
  running: Array<{ startedAt: number | null; waitingGpu: boolean }>,
  queued: number,
  averageMs: number | null,
  now: number,
): { etaSeconds: number | null; basis: EtaBasis } {
  if (running.length === 0 && queued === 0) return { etaSeconds: 0, basis: null }
  if (averageMs === null) return { etaSeconds: null, basis: 'insufficient_data' }

  let total = 0
  for (const item of running) {
    // A job still waiting for the card has spent no time on its own work.
    const elapsed =
      item.waitingGpu || item.startedAt === null ? 0 : Math.max(0, now - item.startedAt)
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

/** The pipelines that must hold the single card to make progress. */
function isGpuPipeline(pipeline: WorkPipeline): boolean {
  return pipeline === 'asr' || pipeline === 'translation' || pipeline === 'embedding' || pipeline === 'scene'
}

function pipelineOf(kind: string): WorkPipeline {
  if (
    kind === 'asr' ||
    kind === 'translation' ||
    kind === 'embedding' ||
    kind === 'scene' ||
    kind === 'mutation' ||
    kind === 'backup' ||
    kind === 'maintenance' ||
    kind === 'bulk'
  ) {
    return kind
  }
  return 'media'
}

/**
 * One read model over every queue. Media and mutations run on the CPU side,
 * while ASR, translation, embedding and scene take turns on the single card.
 */
export function workQueue(
  db: Db,
  now: number,
  gpuResource: string,
  options: { maxSceneWindows?: number } = {},
): WorkQueueRecord {
  const maxSceneWindows = options.maxSceneWindows ?? 120
  const media = db
    .query<RawItem, Params>(
      `SELECT j.id, j.kind, j.asset_id AS assetId, a.filename AS assetName,
              j.state, j.phase AS stage,
              NULL AS progress,
              NULL AS onGpu,
              j.started_at AS startedAt, j.updated_at AS updatedAt,
              j.lease_expires_at AS leaseExpiresAt, j.last_error AS errorMessage,
              NULL AS errorCode
       FROM jobs j LEFT JOIN assets a ON a.id = j.asset_id
       WHERE j.state IN ('queued','running') AND j.kind <> 'maintenance'
       ORDER BY CASE j.state WHEN 'running' THEN 0 ELSE 1 END, j.priority ASC, j.id ASC
       LIMIT ?`,
    )
    .all(ITEM_LIMIT)

  // Maintenance work shares the `jobs` table, so the media lane excludes it and
  // this lane selects only it. Without the split a duplicate scan is counted twice.
  const maintenance = db
    .query<RawItem, Params>(
      `SELECT j.id, j.kind, j.asset_id AS assetId, a.filename AS assetName,
              j.state, j.phase AS stage,
              NULL AS progress,
              NULL AS onGpu,
              j.started_at AS startedAt, j.updated_at AS updatedAt,
              j.lease_expires_at AS leaseExpiresAt, j.last_error AS errorMessage,
              NULL AS errorCode
       FROM jobs j LEFT JOIN assets a ON a.id = j.asset_id
       WHERE j.state IN ('queued','running') AND j.kind = 'maintenance'
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
              j.lease_expires_at AS leaseExpiresAt, j.error_message AS errorMessage,
              NULL AS errorCode
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
              j.lease_expires_at AS leaseExpiresAt, j.error_message AS errorMessage,
              NULL AS errorCode
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
              j.lease_expires_at AS leaseExpiresAt, j.error_message AS errorMessage,
              NULL AS errorCode
       FROM embedding_jobs j LEFT JOIN assets a ON a.id = j.asset_id
       LEFT JOIN gpu_leases g ON g.resource_id = ? AND g.released_at IS NULL
       WHERE j.state IN ('queued','embedding','writing')
       ORDER BY CASE j.state WHEN 'queued' THEN 1 ELSE 0 END, j.created_at ASC
       LIMIT ?`,
    )
    .all(gpuResource, ITEM_LIMIT)

  const scene = db
    .query<RawItem, Params>(
      `SELECT j.id, 'scene' AS kind, j.asset_id AS assetId, a.filename AS assetName,
              j.state, j.stage, j.progress,
              CASE WHEN g.owner = j.lease_owner THEN 1 ELSE 0 END AS onGpu,
              j.started_at AS startedAt, j.updated_at AS updatedAt,
              j.lease_expires_at AS leaseExpiresAt, j.error_message AS errorMessage,
              NULL AS errorCode,
              a.duration_ms AS durationMs, j.window_ms AS windowMs, j.overlap_ms AS overlapMs
       FROM scene_jobs j LEFT JOIN assets a ON a.id = j.asset_id
       LEFT JOIN gpu_leases g ON g.resource_id = ? AND g.released_at IS NULL
       WHERE j.state IN ('queued','extracting','embedding','writing')
       ORDER BY CASE j.state WHEN 'queued' THEN 1 ELSE 0 END, j.created_at ASC
       LIMIT ?`,
    )
    .all(gpuResource, ITEM_LIMIT)

  const mutation = db
    .query<RawItem, Params>(
      `SELECT m.id, 'mutation' AS kind, m.asset_id AS assetId, a.filename AS assetName,
              m.state, m.kind AS stage, NULL AS progress, 0 AS onGpu,
              m.created_at AS startedAt, m.updated_at AS updatedAt,
              m.lease_expires_at AS leaseExpiresAt, m.error_message AS errorMessage,
              m.error_code AS errorCode
       FROM file_mutations m LEFT JOIN assets a ON a.id = m.asset_id
       WHERE m.state IN (
         'requested','validated','quarantined','db_committed','purging',
         'failed_retryable','blocked'
       )
       ORDER BY CASE m.state
                  WHEN 'failed_retryable' THEN 1
                  WHEN 'blocked' THEN 2
                  ELSE 0
                END,
                m.updated_at ASC
       LIMIT ?`,
    )
    .all(ITEM_LIMIT)

  // The bulk lane reports the operation, not each item: a 10k delete is one
  // line with a percentage, and the bulk page owns the per-file detail.
  const bulk = db
    .query<RawItem, Params>(
      `SELECT o.id, 'bulk' AS kind, NULL AS assetId,
              o.kind || ' · ' || o.snapshot_count || '개' AS assetName,
              o.state, o.kind AS stage,
              CASE WHEN o.snapshot_count > 0 THEN
                CAST((SELECT COUNT(*) FROM bulk_operation_items i
                      WHERE i.operation_id = o.id
                        AND i.state IN ('succeeded','failed','held','cancelled')) * 100
                     / o.snapshot_count AS INTEGER)
              ELSE 0 END AS progress,
              0 AS onGpu, o.created_at AS startedAt, o.updated_at AS updatedAt,
              o.lease_expires_at AS leaseExpiresAt, o.error_message AS errorMessage,
              o.error_code AS errorCode
       FROM bulk_operations o
       WHERE o.state IN ('queued','running','cancelling','failed')
       ORDER BY CASE o.state WHEN 'failed' THEN 1 ELSE 0 END, o.created_at ASC
       LIMIT ?`,
    )
    .all(ITEM_LIMIT)

  const bulkCounts = counts(
    db
      .query<CountRow, []>(
        `SELECT state, COUNT(*) AS n FROM bulk_operations
         WHERE state IN ('queued','running','cancelling') GROUP BY state`,
      )
      .all(),
    ['running', 'cancelling'],
  )

  const mediaCounts = counts(
    db
      .query<CountRow, []>(
        "SELECT state, COUNT(*) AS n FROM jobs WHERE state IN ('queued','running') AND kind <> 'maintenance' GROUP BY state",
      )
      .all(),
    ['running'],
  )
  const maintenanceCounts = counts(
    db
      .query<CountRow, []>(
        "SELECT state, COUNT(*) AS n FROM jobs WHERE state IN ('queued','running') AND kind = 'maintenance' GROUP BY state",
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
  const sceneCounts = counts(
    db
      .query<CountRow, []>(
        `SELECT state, COUNT(*) AS n FROM scene_jobs
         WHERE state IN ('queued','extracting','embedding','writing') GROUP BY state`,
      )
      .all(),
    ['extracting', 'embedding', 'writing'],
  )
  const mutationCounts = counts(
    db
      .query<CountRow, []>(
        `SELECT state, COUNT(*) AS n FROM file_mutations
         WHERE state IN (
           'requested','validated','quarantined','db_committed','purging',
           'failed_retryable','blocked'
         ) GROUP BY state`,
      )
      .all(),
    LANE_STATES.mutation.active,
  )

  const countsByPipeline: Record<WorkPipeline, { running: number; queued: number }> = {
    media: mediaCounts,
    asr: asrCounts,
    translation: translationCounts,
    embedding: embeddingCounts,
    scene: sceneCounts,
    mutation: { running: mutationCounts.running, queued: 0 },
    backup: { running: 0, queued: 0 },
    maintenance: maintenanceCounts,
    bulk: bulkCounts,
  }

  const toItem = (raw: RawItem, pipeline: WorkPipeline): WorkItemRecord => {
    const lane = LANE_STATES[pipeline]
    const active = lane.active.includes(raw.state)
    const failed = lane.failed.includes(raw.state) || raw.state === 'failed'
    const stalled = active && raw.leaseExpiresAt !== null && raw.leaseExpiresAt < now
    const parsed = parseJobError(raw.errorMessage)
    const gpuLane = isGpuPipeline(pipeline)
    const state: WorkItemRecord['state'] = failed
      ? 'failed'
      : stalled
        ? 'stalled'
        : active
          ? 'running'
          : 'queued'
    return {
      id: String(raw.id),
      pipeline,
      kind: raw.kind ?? pipeline,
      assetId: raw.assetId,
      assetName: raw.assetName,
      state,
      stage: raw.stage,
      progress: raw.progress,
      onGpu: gpuLane ? raw.onGpu === 1 : null,
      waitingGpu: state === 'running' && gpuLane && raw.onGpu !== 1,
      coverage:
        pipeline === 'scene'
          ? sceneCoverage(raw.durationMs, raw.windowMs ?? 0, raw.overlapMs ?? 0, maxSceneWindows)
          : null,
      startedAt: raw.startedAt,
      updatedAt: raw.updatedAt,
      etaSeconds: null,
      errorCode: raw.errorCode ?? parsed.code,
      errorMessage: parsed.message,
    }
  }

  const itemsByPipeline: Record<WorkPipeline, WorkItemRecord[]> = {
    media: media.map((raw) => toItem(raw, 'media')),
    asr: asr.map((raw) => toItem(raw, 'asr')),
    translation: translation.map((raw) => toItem(raw, 'translation')),
    embedding: embedding.map((raw) => toItem(raw, 'embedding')),
    scene: scene.map((raw) => toItem(raw, 'scene')),
    mutation: mutation.map((raw) => toItem(raw, 'mutation')),
    backup: [],
    maintenance: maintenance.map((raw) => toItem(raw, 'maintenance')),
    bulk: bulk.map((raw) => toItem(raw, 'bulk')),
  }

  const averages: Record<WorkPipeline, number | null> = {
    media: history(db, 'jobs', 'done', now),
    asr: history(db, 'asr_jobs', 'completed', now),
    translation: history(db, 'translation_jobs', 'completed', now),
    embedding: history(db, 'embedding_jobs', 'completed', now),
    scene: history(db, 'scene_jobs', 'completed', now),
    mutation: null,
    backup: null,
    maintenance: null,
    bulk: null,
  }

  const pipelines: WorkPipelineRecord[] = WORK_PIPELINES.map((pipeline) => {
    const items = itemsByPipeline[pipeline]
    const live = items.filter((item) => item.state === 'running')
    const stalled = items.filter((item) => item.state === 'stalled').length
    const { etaSeconds, basis } = pipelineEta(
      live,
      countsByPipeline[pipeline].queued,
      averages[pipeline],
      now,
    )
    return {
      pipeline,
      running: Math.max(0, countsByPipeline[pipeline].running - stalled),
      queued: countsByPipeline[pipeline].queued,
      stalled,
      runningGpu: live.filter((item) => item.onGpu === true).length,
      waitingGpu: live.filter((item) => item.waitingGpu).length,
      etaSeconds: stalled > 0 ? null : etaSeconds,
      basis: stalled > 0 ? 'insufficient_data' : basis,
    }
  })

  const all = WORK_PIPELINES.flatMap((pipeline) => itemsByPipeline[pipeline])

  // The card is serial, so a waiting job finishes after the current holder.
  // The holder's median already covers its own model load, because the stage
  // loads the model after it takes the card.
  const holder = all.find((item) => item.state === 'running' && item.onGpu === true) ?? null
  const holderAverage = holder ? averages[holder.pipeline] : null
  const holderRemainingMs =
    holder === null || holderAverage === null
      ? 0
      : Math.max(0, holderAverage - (holder.startedAt === null ? 0 : now - holder.startedAt))

  for (const pipeline of WORK_PIPELINES) {
    for (const item of itemsByPipeline[pipeline]) {
      if (item.state !== 'running') continue
      const average = averages[item.pipeline]
      if (average === null) continue
      if (item.waitingGpu) {
        item.etaSeconds = Math.round((holderRemainingMs + average) / 1000)
        continue
      }
      const elapsed = item.startedAt === null ? 0 : Math.max(0, now - item.startedAt)
      item.etaSeconds = Math.max(0, Math.round((average - elapsed) / 1000))
    }
  }

  const laneOf = (pipeline: WorkPipeline) => pipelines.find((lane) => lane.pipeline === pipeline)!
  const cpuLanes = [laneOf('media'), laneOf('mutation')]
  const gpuLanes = pipelines.filter((lane) => isGpuPipeline(lane.pipeline))

  const laneBusy = (lane: WorkPipelineRecord) => lane.running + lane.queued + lane.stalled > 0
  const sumEta = (lanes: WorkPipelineRecord[]) =>
    lanes.every((lane) => lane.etaSeconds !== null)
      ? lanes.reduce((total, lane) => total + (lane.etaSeconds ?? 0), 0)
      : null

  const cpuBusy = cpuLanes.some(laneBusy)
  const gpuBusy = gpuLanes.some(laneBusy)
  const cpuEta = sumEta(cpuLanes)
  const gpuEta = sumEta(gpuLanes)

  const overall: number | null =
    !cpuBusy && !gpuBusy
      ? 0
      : (cpuBusy && cpuEta === null) || (gpuBusy && gpuEta === null)
        ? null
        : Math.max(cpuBusy ? (cpuEta ?? 0) : 0, gpuBusy ? (gpuEta ?? 0) : 0)

  const basis: EtaBasis =
    overall !== null
      ? cpuBusy || gpuBusy
        ? 'history'
        : null
      : 'insufficient_data'

  // A failure is live only when no newer attempt for the same work exists.
  // Retrying writes a newer row, so the older one is history, not a failure.
  const failures = db
    .query<RawItem, Params>(
      `SELECT * FROM (
         SELECT j.id, j.kind, j.asset_id AS assetId, a.filename AS assetName,
                j.state, NULL AS stage, NULL AS progress, NULL AS onGpu,
                j.started_at AS startedAt, j.updated_at AS updatedAt,
                NULL AS leaseExpiresAt, j.last_error AS errorMessage, NULL AS errorCode
         FROM jobs j LEFT JOIN assets a ON a.id = j.asset_id
         LEFT JOIN libraries l ON l.id = j.library_id
         WHERE j.state = 'failed' AND (j.library_id IS NULL OR l.id IS NOT NULL)
           AND NOT EXISTS (
             SELECT 1 FROM jobs n WHERE n.dedupe_key = j.dedupe_key AND n.updated_at > j.updated_at
           )
         UNION ALL
         SELECT j.id, 'asr', j.asset_id, a.filename, j.state, j.stage, j.progress,
                NULL, j.started_at, j.updated_at, NULL, j.error_message, NULL
         FROM asr_jobs j LEFT JOIN assets a ON a.id = j.asset_id
         WHERE j.state = 'failed' AND NOT EXISTS (
           SELECT 1 FROM asr_jobs n
           WHERE n.asset_id = j.asset_id AND n.file_version = j.file_version
             AND n.updated_at > j.updated_at
         )
         UNION ALL
         SELECT j.id, 'translation', j.asset_id, a.filename, j.state, j.stage, j.progress,
                NULL, j.started_at, j.updated_at, NULL, j.error_message, NULL
         FROM translation_jobs j LEFT JOIN assets a ON a.id = j.asset_id
         WHERE j.state = 'failed' AND NOT EXISTS (
           SELECT 1 FROM translation_jobs n
           WHERE n.asset_id = j.asset_id AND n.file_version = j.file_version
             AND n.target_language = j.target_language AND n.updated_at > j.updated_at
         )
         UNION ALL
         SELECT j.id, 'embedding', j.asset_id, a.filename, j.state, j.stage, j.progress,
                NULL, j.started_at, j.updated_at, NULL, j.error_message, NULL
         FROM embedding_jobs j LEFT JOIN assets a ON a.id = j.asset_id
         WHERE j.state = 'failed' AND NOT EXISTS (
           SELECT 1 FROM embedding_jobs n
           WHERE n.asset_id = j.asset_id AND n.file_version = j.file_version
             AND n.updated_at > j.updated_at
         )
         UNION ALL
         SELECT j.id, 'scene', j.asset_id, a.filename, j.state, j.stage, j.progress,
                NULL, j.started_at, j.updated_at, NULL, j.error_message, NULL
         FROM scene_jobs j LEFT JOIN assets a ON a.id = j.asset_id
         WHERE j.state = 'failed' AND NOT EXISTS (
           SELECT 1 FROM scene_jobs n
           WHERE n.asset_id = j.asset_id AND n.file_version = j.file_version
             AND n.updated_at > j.updated_at
         )
         UNION ALL
         SELECT m.id, 'mutation', m.asset_id, a.filename, m.state, m.kind, NULL,
                0, m.created_at, m.updated_at, m.lease_expires_at, m.error_message, m.error_code
         FROM file_mutations m LEFT JOIN assets a ON a.id = m.asset_id
         WHERE m.state IN ('failed_retryable','blocked')
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
           UNION ALL SELECT MAX(updated_at) FROM scene_jobs WHERE state = 'completed'
           UNION ALL SELECT MAX(updated_at) FROM file_mutations WHERE state = 'completed'
         )`,
      )
      .get()?.last ?? null

  return {
    generatedAt: now,
    running: all.filter((item) => item.state === 'running'),
    queued: all.filter((item) => item.state === 'queued'),
    stalled: all.filter((item) => item.state === 'stalled'),
    remaining: WORK_PIPELINES.reduce(
      (total, pipeline) =>
        total + countsByPipeline[pipeline].running + countsByPipeline[pipeline].queued,
      0,
    ),
    etaSeconds: overall,
    basis,
    pipelines,
    failures: failures.map((raw) => toItem(raw, pipelineOf(raw.kind ?? 'media'))),
    lastCompletedAt,
  }
}
