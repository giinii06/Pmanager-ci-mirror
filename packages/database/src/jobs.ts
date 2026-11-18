import type { SQLQueryBindings } from 'bun:sqlite'
import type { JobKind, JobState, Priority } from '@mediavault/shared'
import type { Db } from './db'
import type { JobRecord } from './types'

type Params = SQLQueryBindings[]

export const DEFAULT_JOB_LEASE_MS = 120_000

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
export function enqueueJob(db: Db, input: EnqueueJobInput, now: number): void {
  db.query<null, Params>(
    `INSERT INTO jobs (
       dedupe_key, kind, state, priority, asset_id, library_id, payload, max_attempts,
       progress_total, created_at, updated_at
     ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (dedupe_key) WHERE state IN ('queued','running','paused') DO UPDATE SET
       priority = MIN(jobs.priority, excluded.priority),
       updated_at = excluded.updated_at`,
  ).run(
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
           ORDER BY priority ASC, id ASC
           LIMIT 1
         )
         RETURNING ${JOB_SELECT}`,
      )
      .get(workerId, leaseExpiresAt, now, now, now) ?? null
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
): boolean {
  let mutated = false
  db.transaction(() => {
    const job = db
      .query<
        {
          state: JobState
          attempts: number
          maxAttempts: number
          workerId: string | null
          leaseEpoch: number
          leaseExpiresAt: number | null
        },
        Params
      >(
        `SELECT state, attempts, max_attempts AS maxAttempts,
                worker_id AS workerId, lease_epoch AS leaseEpoch, lease_expires_at AS leaseExpiresAt
         FROM jobs WHERE id = ?`,
      )
      .get(id)
    if (!job || job.state !== 'running') return
    if (
      fence &&
      (job.workerId !== fence.workerId ||
        job.leaseEpoch !== fence.leaseEpoch ||
        job.leaseExpiresAt === null ||
        job.leaseExpiresAt <= fence.now)
    ) {
      return
    }
    const fenceClause = fence
      ? ' AND state = \'running\' AND worker_id = ? AND lease_epoch = ? AND lease_expires_at > ?'
      : " AND state = 'running'"
    const fenceParams: SQLQueryBindings[] = fence ? [fence.workerId, fence.leaseEpoch, fence.now] : []

    if (job.attempts >= job.maxAttempts) {
      mutated =
        db
          .query<null, Params>(
            `UPDATE jobs SET
               state = 'failed',
               worker_id = NULL,
               lease_expires_at = NULL,
               last_error = ?,
               completed_at = ?,
               updated_at = ?
             WHERE id = ?${fenceClause}`,
          )
          .run(message, now, now, id, ...fenceParams).changes === 1
      return
    }

    const backoff = Math.min(30_000, 1_000 * job.attempts * job.attempts)
    mutated =
      db
        .query<null, Params>(
          `UPDATE jobs SET
             state = 'queued',
             worker_id = NULL,
             lease_expires_at = NULL,
             last_error = ?,
             run_after = ?,
             updated_at = ?
           WHERE id = ?${fenceClause}`,
        )
        .run(message, now + backoff, now, id, ...fenceParams).changes === 1
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

export function cancelRunningJobWithFence(db: Db, id: number, fence: LeaseFence): boolean {
  const guard = assertFencedRunning(fence)
  return (
    db
      .query<null, Params>(
        `UPDATE jobs SET
           state = 'cancelled',
           worker_id = NULL,
           lease_expires_at = NULL,
           cancel_requested = 0,
           phase = 'cancelled',
           completed_at = ?,
           updated_at = ?
         ${guard.clause}`,
      )
      .run(fence.now, fence.now, id, ...guard.params).changes === 1
  )
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
      .query<null, Params>(
        `UPDATE jobs SET
           state = 'cancelled',
           worker_id = NULL,
           lease_expires_at = NULL,
           pause_requested = 0,
           cancel_requested = 0,
           phase = 'cancelled',
           completed_at = ?,
           updated_at = ?
         WHERE id = ? AND state IN ('queued','paused')`,
      )
      .run(now, now, id)
    if (inactive.changes > 0) return
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
      .query<null, Params>(
        `UPDATE jobs SET
           state = 'cancelled',
           worker_id = NULL,
           lease_expires_at = NULL,
           cancel_requested = 0,
           pause_requested = 0,
           completed_at = ?,
           updated_at = ?
         WHERE state = 'running' AND cancel_requested = 1
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .run(now, now, now).changes

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

    recovered = cancelled + paused + requeued
  }).immediate()
  return recovered
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

export function pruneOldJobs(db: Db, olderThanMs: number): number {
  return db
    .query<null, Params>(
      "DELETE FROM jobs WHERE state IN ('done','cancelled','failed') AND updated_at < ?",
    )
    .run(olderThanMs).changes
}
