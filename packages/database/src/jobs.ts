import type { SQLQueryBindings } from 'bun:sqlite'
import {
  formatJobError,
  isEnvironmentJobError,
  type JobErrorCode,
  type JobKind,
  type JobState,
  type Priority,
} from '@mediavault/shared'
import type { Db } from './db'
import type { JobRecord } from './types'

type Params = SQLQueryBindings[]

export const DEFAULT_JOB_LEASE_MS = 120_000

/**
 * A queued job gains one priority level every two minutes, so a backlog job
 * reaches `now` after eight minutes and cannot be starved by a stream of
 * user-visible work. The raw priority still breaks ties, so fresh work stays
 * ahead of a job that aged to the same effective level.
 */
const AGING_MS_PER_LEVEL = 120_000

const JOB_SELECT = `
  id, kind, state, priority, asset_id AS assetId, library_id AS libraryId, payload,
  attempts, max_attempts AS maxAttempts,
  worker_id AS workerId, lease_epoch AS leaseEpoch, lease_expires_at AS leaseExpiresAt,
  progress_current AS progressCurrent, progress_total AS progressTotal,
  phase, checkpoint,
  pause_requested AS pauseRequested, cancel_requested AS cancelRequested,
  last_error AS lastError, started_at AS startedAt, completed_at AS completedAt,
  updated_at AS updatedAt
`

export interface EnqueueJobInput {
  dedupeKey: string
  kind: JobKind
  priority: Priority
  assetId?: string | null
  libraryId?: string | null
  payload?: unknown
  maxAttempts?: number
  progressTotal?: number | null
}

export interface LeaseFence {
  workerId: string
  leaseEpoch: number
  now: number
}

export interface ClaimOptions {
  workerId?: string
  leaseMs?: number
}

export interface JobProgressPatch {
  progressCurrent?: number
  progressTotal?: number | null
  phase?: string | null
  checkpoint?: string | null
}

/**
 * Deduplicates against active (`queued`, `running`, `paused`) rows so a paused
 * job keeps its reservation and checkpoint instead of spawning a duplicate run.
 */
export function enqueueJob(db: Db, input: EnqueueJobInput, now: number): JobState {
  const row = db
    .query<{ state: JobState }, Params>(
      `INSERT INTO jobs (
         dedupe_key, kind, state, priority, asset_id, library_id, payload, max_attempts,
         progress_total, created_at, updated_at
       ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (dedupe_key) WHERE state IN ('queued','running','paused') DO UPDATE SET
         priority = MIN(jobs.priority, excluded.priority),
         updated_at = excluded.updated_at
       RETURNING state`,
    )
    .get(
      input.dedupeKey,
      input.kind,
      input.priority,
      input.assetId ?? null,
      input.libraryId ?? null,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.maxAttempts ?? 3,
      input.progressTotal ?? null,
      now,
      now,
    )
  return row?.state ?? 'queued'
}

export function findPausedScanJob(db: Db, libraryId: string): JobRecord | null {
  return (
    db
      .query<JobRecord, Params>(
        `SELECT ${JOB_SELECT} FROM jobs
         WHERE kind = 'scan_library' AND library_id = ? AND state = 'paused'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(libraryId) ?? null
  )
}

export function claimNextJob(
  db: Db,
  now: number,
  options: ClaimOptions = {},
): JobRecord | null {
  const workerId = options.workerId ?? 'worker-default'
  const leaseExpiresAt = now + (options.leaseMs ?? DEFAULT_JOB_LEASE_MS)
  return (
    db
      .query<JobRecord, Params>(
        `UPDATE jobs SET
           state = 'running',
           attempts = attempts + 1,
           worker_id = ?,
           lease_epoch = lease_epoch + 1,
           lease_expires_at = ?,
           pause_requested = 0,
           cancel_requested = 0,
           started_at = ?,
           updated_at = ?
         WHERE id = (
           SELECT id FROM jobs
           WHERE state = 'queued' AND run_after <= ?
           ORDER BY
             MAX(0, priority - CAST((? - created_at) / ${AGING_MS_PER_LEVEL} AS INTEGER)) ASC,
             priority ASC,
             id ASC
           LIMIT 1
         )
         RETURNING ${JOB_SELECT}`,
      )
      .get(workerId, leaseExpiresAt, now, now, now, now) ?? null
  )
}

export function getJob(db: Db, id: number): JobRecord | null {
  return db.query<JobRecord, Params>(`SELECT ${JOB_SELECT} FROM jobs WHERE id = ?`).get(id) ?? null
}

function assertFencedRunning(fence: LeaseFence): { clause: string; params: SQLQueryBindings[] } {
  return {
    clause:
      "WHERE id = ? AND state = 'running' AND worker_id = ? AND lease_epoch = ? AND lease_expires_at > ?",
    params: [fence.workerId, fence.leaseEpoch, fence.now],
  }
}

export function heartbeatJob(
  db: Db,
  id: number,
  fence: LeaseFence,
  extendMs: number = DEFAULT_JOB_LEASE_MS,
  patch: JobProgressPatch = {},
): { alive: boolean; pauseRequested: boolean; cancelRequested: boolean } {
  const nextExpiry = fence.now + extendMs
  const sets = ['lease_expires_at = ?', 'updated_at = ?']
  const params: SQLQueryBindings[] = [nextExpiry, fence.now]
  if (patch.progressCurrent !== undefined) {
    sets.push('progress_current = ?')
    params.push(patch.progressCurrent)
  }
  if (patch.progressTotal !== undefined) {
    sets.push('progress_total = ?')
    params.push(patch.progressTotal)
  }
  if (patch.phase !== undefined) {
    sets.push('phase = ?')
    params.push(patch.phase)
  }
  if (patch.checkpoint !== undefined) {
    sets.push('checkpoint = ?')
    params.push(patch.checkpoint)
  }
  const guard = assertFencedRunning(fence)
  const row = db
    .query<{ pauseRequested: 0 | 1; cancelRequested: 0 | 1 }, Params>(
      `UPDATE jobs SET ${sets.join(', ')}
       ${guard.clause}
       RETURNING pause_requested AS pauseRequested, cancel_requested AS cancelRequested`,
    )
    .get(...params, id, ...guard.params)
  if (!row) return { alive: false, pauseRequested: false, cancelRequested: false }
  return {
    alive: true,
    pauseRequested: row.pauseRequested === 1,
    cancelRequested: row.cancelRequested === 1,
  }
}

export function saveJobCheckpoint(
  db: Db,
  id: number,
  fence: LeaseFence,
  patch: JobProgressPatch,
): boolean {
  const sets = ['updated_at = ?']
  const params: SQLQueryBindings[] = [fence.now]
  if (patch.checkpoint !== undefined) {
    sets.push('checkpoint = ?')
    params.push(patch.checkpoint)
  }
  if (patch.phase !== undefined) {
    sets.push('phase = ?')
    params.push(patch.phase)
  }
  if (patch.progressCurrent !== undefined) {
    sets.push('progress_current = ?')
    params.push(patch.progressCurrent)
  }
  if (patch.progressTotal !== undefined) {
    sets.push('progress_total = ?')
    params.push(patch.progressTotal)
  }
  const guard = assertFencedRunning(fence)
  return (
    db
      .query<null, Params>(`UPDATE jobs SET ${sets.join(', ')} ${guard.clause}`)
      .run(...params, id, ...guard.params).changes === 1
  )
}

export function completeJob(db: Db, id: number, now: number, fence?: LeaseFence): boolean {
  if (fence) {
    const guard = assertFencedRunning(fence)
    return (
      db
        .query<null, Params>(
          `UPDATE jobs SET
             state = 'done',
             worker_id = NULL,
             lease_expires_at = NULL,
             phase = 'completed',
             pause_requested = 0,
             cancel_requested = 0,
             last_error = NULL,
             completed_at = ?,
             updated_at = ?
           ${guard.clause}`,
        )
        .run(now, now, id, ...guard.params).changes === 1
    )
  }
  return (
    db
      .query<null, Params>(
        `UPDATE jobs SET
           state = 'done',
           worker_id = NULL,
           lease_expires_at = NULL,
           phase = 'completed',
           last_error = NULL,
           completed_at = ?,
           updated_at = ?
         WHERE id = ? AND state = 'running'`,
      )
      .run(now, now, id).changes === 1
  )
}

export function failJob(
  db: Db,
  id: number,
  message: string,
  now: number,
  fence?: LeaseFence,
  code?: JobErrorCode,
): boolean {
  let mutated = false
  db.transaction(() => {
    const job = db
      .query<{ attempts: number; maxAttempts: number }, Params>(
        "SELECT attempts, max_attempts AS maxAttempts FROM jobs WHERE id = ? AND state = 'running'",
      )
      .get(id)
    if (!job) return
    const guard = fence
      ? assertFencedRunning(fence)
      : { clause: "WHERE id = ? AND state = 'running'", params: [] as SQLQueryBindings[] }
    // A missing source or a full disk is the environment's problem; retrying the
    // same job cannot fix it, so the row waits as a failure until recovery
    // requeues it (SOURCE_OFFLINE) or an operator acts (DISK_FULL).
    const exhausted = isEnvironmentJobError(code ?? null) || job.attempts >= job.maxAttempts
    const stored = code ? formatJobError(code, message) : message
    const backoff = exhausted ? 0 : Math.min(30_000, 1_000 * job.attempts * job.attempts)
    mutated =
      db
        .query<null, Params>(
          exhausted
            ? `UPDATE jobs SET
                 state = 'failed',
                 worker_id = NULL,
                 lease_expires_at = NULL,
                 last_error = ?,
                 completed_at = ?,
                 updated_at = ?
               ${guard.clause}`
            : `UPDATE jobs SET
                 state = 'queued',
                 worker_id = NULL,
                 lease_expires_at = NULL,
                 last_error = ?,
                 run_after = ?,
                 updated_at = ?
               ${guard.clause}`,
        )
        .run(stored, ...(exhausted ? [now, now] : [now + backoff, now]), id, ...guard.params)
        .changes === 1
  }).immediate()
  return mutated
}

export function pauseRunningJobWithFence(db: Db, id: number, fence: LeaseFence): boolean {
  const guard = assertFencedRunning(fence)
  return (
    db
      .query<null, Params>(
        `UPDATE jobs SET
           state = 'paused',
           worker_id = NULL,
           lease_expires_at = NULL,
           attempts = MAX(0, attempts - 1),
           pause_requested = 0,
           phase = 'paused',
           updated_at = ?
         ${guard.clause}`,
      )
      .run(fence.now, id, ...guard.params).changes === 1
  )
}

export function requeueInterruptedJobWithFence(db: Db, id: number, fence: LeaseFence): boolean {
  const guard = assertFencedRunning(fence)
  return (
    db
      .query<null, Params>(
        `UPDATE jobs SET
           state = 'queued',
           worker_id = NULL,
           lease_expires_at = NULL,
           attempts = MAX(0, attempts - 1),
           run_after = ?,
           updated_at = ?
         ${guard.clause}`,
      )
      .run(fence.now, fence.now, id, ...guard.params).changes === 1
  )
}

function clearCancelledScanLibraryState(db: Db, libraryId: string): void {
  db.query<null, Params>('DELETE FROM scan_checkpoints WHERE library_id = ?').run(libraryId)
  db.query<null, Params>(
    "UPDATE libraries SET scan_state = 'idle', last_error = NULL WHERE id = ? AND scan_state IN ('queued','scanning','paused')",
  ).run(libraryId)
}

export function cancelRunningJobWithFence(db: Db, id: number, fence: LeaseFence): boolean {
  const guard = assertFencedRunning(fence)
  let changed = false
  db.transaction(() => {
    const cancelled = db
      .query<{ kind: JobKind; libraryId: string | null }, Params>(
        `UPDATE jobs SET
           state = 'cancelled',
           worker_id = NULL,
           lease_expires_at = NULL,
           cancel_requested = 0,
           phase = 'cancelled',
           completed_at = ?,
           updated_at = ?
         ${guard.clause}
         RETURNING kind, library_id AS libraryId`,
      )
      .get(fence.now, fence.now, id, ...guard.params)
    if (!cancelled) return
    changed = true
    if (cancelled.kind === 'scan_library' && cancelled.libraryId) {
      clearCancelledScanLibraryState(db, cancelled.libraryId)
    }
  }).immediate()
  return changed
}

export function pauseJob(db: Db, id: number, now: number): JobRecord | null {
  db.transaction(() => {
    const queued = db
      .query<null, Params>(
        `UPDATE jobs SET state = 'paused', pause_requested = 0, phase = 'paused', updated_at = ?
         WHERE id = ? AND state = 'queued'`,
      )
      .run(now, id)
    if (queued.changes > 0) return
    db.query<null, Params>(
      "UPDATE jobs SET pause_requested = 1, updated_at = ? WHERE id = ? AND state = 'running'",
    ).run(now, id)
  }).immediate()
  return getJob(db, id)
}

export function resumeJob(db: Db, id: number, now: number): JobRecord | null {
  db.query<null, Params>(
    `UPDATE jobs SET
       state = 'queued',
       pause_requested = 0,
       cancel_requested = 0,
       run_after = ?,
       updated_at = ?
     WHERE id = ? AND state = 'paused'`,
  ).run(now, now, id)
  return getJob(db, id)
}

export function cancelJob(db: Db, id: number, now: number): JobRecord | null {
  db.transaction(() => {
    const inactive = db
      .query<{ kind: JobKind; libraryId: string | null }, Params>(
        `UPDATE jobs SET
           state = 'cancelled',
           worker_id = NULL,
           lease_expires_at = NULL,
           pause_requested = 0,
           cancel_requested = 0,
           phase = 'cancelled',
           completed_at = ?,
           updated_at = ?
         WHERE id = ? AND state IN ('queued','paused')
         RETURNING kind, library_id AS libraryId`,
      )
      .get(now, now, id)
    if (inactive) {
      if (inactive.kind === 'scan_library' && inactive.libraryId) {
        clearCancelledScanLibraryState(db, inactive.libraryId)
      }
      return
    }
    db.query<null, Params>(
      "UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND state = 'running'",
    ).run(now, id)
  }).immediate()
  return getJob(db, id)
}

export function recoverExpiredJobs(db: Db, now: number): number {
  let recovered = 0
  db.transaction(() => {
    const cancelled = db
      .query<{ kind: JobKind; libraryId: string | null }, Params>(
        `UPDATE jobs SET
           state = 'cancelled',
           worker_id = NULL,
           lease_expires_at = NULL,
           cancel_requested = 0,
           pause_requested = 0,
           completed_at = ?,
           updated_at = ?
         WHERE state = 'running' AND cancel_requested = 1
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
         RETURNING kind, library_id AS libraryId`,
      )
      .all(now, now, now)
    for (const row of cancelled) {
      if (row.kind === 'scan_library' && row.libraryId) {
        clearCancelledScanLibraryState(db, row.libraryId)
      }
    }

    const paused = db
      .query<null, Params>(
        `UPDATE jobs SET
           state = 'paused',
           worker_id = NULL,
           lease_expires_at = NULL,
           attempts = MAX(0, attempts - 1),
           pause_requested = 0,
           updated_at = ?
         WHERE state = 'running' AND pause_requested = 1
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .run(now, now).changes

    const requeued = db
      .query<null, Params>(
        `UPDATE jobs SET
           state = 'queued',
           worker_id = NULL,
           lease_expires_at = NULL,
           attempts = MAX(0, attempts - 1),
           run_after = ?,
           updated_at = ?
         WHERE state = 'running'
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .run(now, now, now).changes

    recovered = cancelled.length + paused + requeued
  }).immediate()
  return recovered
}

/**
 * A source that was offline parks its jobs as failures instead of retrying.
 * Once the library is healthy again the same jobs are requeued with a fresh
 * attempt budget. A job whose dedupe key already has an active row stays put,
 * because requeueing it would collide with the unique active index.
 */
export function requeueSourceOfflineJobs(db: Db, now: number): number {
  const rows = db
    .query<{ id: number }, Params>(
      `SELECT j.id FROM jobs j
       LEFT JOIN libraries l
         ON l.id = COALESCE(j.library_id, (SELECT a.library_id FROM assets a WHERE a.id = j.asset_id))
       LEFT JOIN library_health h ON h.library_id = l.id
       WHERE j.state = 'failed'
         AND j.last_error LIKE '[SOURCE_OFFLINE]%'
         AND (l.id IS NULL OR h.state = 'ONLINE')
         AND NOT EXISTS (
           SELECT 1 FROM jobs n
           WHERE n.dedupe_key = j.dedupe_key AND n.state IN ('queued','running','paused')
         )
       ORDER BY j.id ASC
       LIMIT 100`,
    )
    .all()
  if (rows.length === 0) return 0

  let requeued = 0
  db.transaction(() => {
    for (const row of rows) {
      requeued += db
        .query<null, Params>(
          `UPDATE jobs SET
             state = 'queued',
             attempts = 0,
             worker_id = NULL,
             lease_expires_at = NULL,
             run_after = ?,
             updated_at = ?
           WHERE id = ? AND state = 'failed'
             AND NOT EXISTS (
               SELECT 1 FROM jobs n
               WHERE n.dedupe_key = jobs.dedupe_key AND n.state IN ('queued','running','paused')
             )`,
        )
        .run(now, now, row.id).changes
    }
  }).immediate()
  return requeued
}

export function recoverRunningJobs(db: Db, now: number): number {
  return db
    .query<null, Params>(
      `UPDATE jobs SET state = 'queued', worker_id = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE state = 'running'`,
    )
    .run(now).changes
}

export function jobCounts(db: Db): Record<JobState, number> {
  const counts: Record<JobState, number> = {
    queued: 0,
    running: 0,
    paused: 0,
    cancelled: 0,
    done: 0,
    failed: 0,
  }
  const rows = db
    .query<{ state: JobState; n: number }, []>('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state')
    .all()
  for (const row of rows) counts[row.state] = row.n
  return counts
}

export function recentFailures(db: Db, limit = 10): JobRecord[] {
  return db
    .query<JobRecord, Params>(
      `SELECT ${JOB_SELECT} FROM jobs WHERE state = 'failed' ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit)
}

export function activeJobs(db: Db, limit = 20): JobRecord[] {
  return db
    .query<JobRecord, Params>(
      `SELECT ${JOB_SELECT} FROM jobs WHERE state IN ('queued','running','paused')
       ORDER BY CASE state WHEN 'running' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
                priority ASC, id ASC
       LIMIT ?`,
    )
    .all(limit)
}

export function listActiveWorkerLeases(
  db: Db,
  now: number,
): Array<{
  workerId: string
  jobId: number
  kind: JobKind
  phase: string | null
  progressCurrent: number
  progressTotal: number | null
  leaseExpiresAt: number | null
}> {
  return db
    .query<
      {
        workerId: string
        jobId: number
        kind: JobKind
        phase: string | null
        progressCurrent: number
        progressTotal: number | null
        leaseExpiresAt: number | null
      },
      Params
    >(
      `SELECT COALESCE(worker_id, 'unknown') AS workerId, id AS jobId, kind, phase,
              progress_current AS progressCurrent, progress_total AS progressTotal,
              lease_expires_at AS leaseExpiresAt
       FROM jobs
       WHERE state = 'running' AND (lease_expires_at IS NULL OR lease_expires_at > ?)
       ORDER BY id ASC`,
    )
    .all(now)
}

export function hasActiveJob(db: Db, dedupeKey: string): boolean {
  return (
    db
      .query<{ n: number }, Params>(
        "SELECT COUNT(*) AS n FROM jobs WHERE dedupe_key = ? AND state IN ('queued','running','paused')",
      )
      .get(dedupeKey)?.n === 1
  )
}

/** The job a repeat request would have joined, so the caller can report its id. */
export function findActiveJobByDedupe(db: Db, dedupeKey: string): JobRecord | null {
  return (
    db
      .query<JobRecord, Params>(
        `SELECT ${JOB_SELECT} FROM jobs
         WHERE dedupe_key = ? AND state IN ('queued','running','paused')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(dedupeKey) ?? null
  )
}

export function pruneOldJobs(db: Db, olderThanMs: number): number {
  return db
    .query<null, Params>(
      "DELETE FROM jobs WHERE state IN ('done','cancelled','failed') AND updated_at < ?",
    )
    .run(olderThanMs).changes
}
