import type { SQLQueryBindings } from 'bun:sqlite'
import type { JobKind, JobState, Priority } from '@mediavault/shared'
import type { Db } from './db'
import type { JobRecord } from './types'

type Params = SQLQueryBindings[]

const JOB_SELECT = `
  id, kind, state, priority, asset_id AS assetId, library_id AS libraryId, payload,
  attempts, max_attempts AS maxAttempts, last_error AS lastError, updated_at AS updatedAt
`

export interface EnqueueJobInput {
  dedupeKey: string
  kind: JobKind
  priority: Priority
  assetId?: string | null
  libraryId?: string | null
  payload?: unknown
  maxAttempts?: number
}

/**
 * Deduplicates only against queued or running rows. A finished job can be
 * enqueued again, which is what retries after a failure need.
 */
export function enqueueJob(db: Db, input: EnqueueJobInput, now: number): void {
  db.query<null, Params>(
    `INSERT INTO jobs (
       dedupe_key, kind, state, priority, asset_id, library_id, payload, max_attempts,
       created_at, updated_at
     ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (dedupe_key) WHERE state IN ('queued','running') DO UPDATE SET
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
    now,
    now,
  )
}

export function claimNextJob(db: Db, now: number): JobRecord | null {
  return (
    db
      .query<JobRecord, Params>(
        `UPDATE jobs SET state = 'running', attempts = attempts + 1, updated_at = ?
         WHERE id = (
           SELECT id FROM jobs
           WHERE state = 'queued' AND run_after <= ?
           ORDER BY priority ASC, id ASC
           LIMIT 1
         )
         RETURNING ${JOB_SELECT}`,
      )
      .get(now, now) ?? null
  )
}

export function completeJob(db: Db, id: number, now: number): void {
  db.query<null, Params>(
    "UPDATE jobs SET state = 'done', last_error = NULL, updated_at = ? WHERE id = ?",
  ).run(now, id)
}

export function failJob(db: Db, id: number, message: string, now: number): void {
  const job = db
    .query<{ attempts: number; maxAttempts: number }, Params>(
      'SELECT attempts, max_attempts AS maxAttempts FROM jobs WHERE id = ?',
    )
    .get(id)
  if (!job) return
  if (job.attempts >= job.maxAttempts) {
    db.query<null, Params>(
      "UPDATE jobs SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?",
    ).run(message, now, id)
    return
  }
  const backoff = Math.min(30_000, 1_000 * job.attempts * job.attempts)
  db.query<null, Params>(
    "UPDATE jobs SET state = 'queued', last_error = ?, run_after = ?, updated_at = ? WHERE id = ?",
  ).run(message, now + backoff, now, id)
}

export function recoverRunningJobs(db: Db, now: number): number {
  return db
    .query<null, Params>("UPDATE jobs SET state = 'queued', updated_at = ? WHERE state = 'running'")
    .run(now).changes
}

export function jobCounts(db: Db): Record<JobState, number> {
  const counts: Record<JobState, number> = { queued: 0, running: 0, done: 0, failed: 0 }
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
      `SELECT ${JOB_SELECT} FROM jobs WHERE state IN ('queued','running')
       ORDER BY priority ASC, id ASC LIMIT ?`,
    )
    .all(limit)
}

export function hasActiveJob(db: Db, dedupeKey: string): boolean {
  return (
    db
      .query<{ n: number }, Params>(
        "SELECT COUNT(*) AS n FROM jobs WHERE dedupe_key = ? AND state IN ('queued','running')",
      )
      .get(dedupeKey)?.n === 1
  )
}
