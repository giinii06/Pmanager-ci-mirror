import type { SQLQueryBindings } from 'bun:sqlite'
import type { Db } from './db'
import type { WorkerHeartbeatInput, WorkerHeartbeatRecord } from './types'

type Params = SQLQueryBindings[]

const HEARTBEAT_SELECT = `
  instance_id AS instanceId, worker_id AS workerId, component, pid, state,
  current_job_id AS currentJobId, started_at AS startedAt, last_seen_at AS lastSeenAt
`

/**
 * One row per worker boot. The first write stamps `started_at`; later writes
 * only move `last_seen_at` and the current job, so uptime stays truthful.
 */
export function recordWorkerHeartbeat(db: Db, input: WorkerHeartbeatInput): void {
  db.query<null, Params>(
    `INSERT INTO worker_heartbeats (
       instance_id, worker_id, component, pid, state, current_job_id, started_at, last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(instance_id) DO UPDATE SET
       worker_id = excluded.worker_id,
       component = excluded.component,
       pid = excluded.pid,
       state = excluded.state,
       current_job_id = excluded.current_job_id,
       last_seen_at = excluded.last_seen_at`,
  ).run(
    input.instanceId,
    input.workerId,
    input.component,
    input.pid,
    input.state,
    input.currentJobId ?? null,
    input.now,
    input.now,
  )
}

export function listWorkerHeartbeats(db: Db): WorkerHeartbeatRecord[] {
  return db
    .query<WorkerHeartbeatRecord, []>(
      `SELECT ${HEARTBEAT_SELECT} FROM worker_heartbeats ORDER BY last_seen_at DESC`,
    )
    .all()
}

export function pruneWorkerHeartbeats(db: Db, olderThan: number): number {
  return db
    .query<null, Params>('DELETE FROM worker_heartbeats WHERE last_seen_at < ?')
    .run(olderThan).changes
}

/** Distinct boots in a window; Docker reuses `worker_id`, so the id must be per boot. */
export function countWorkerInstancesSince(db: Db, since: number): number {
  return (
    db
      .query<{ n: number }, Params>(
        'SELECT COUNT(DISTINCT instance_id) AS n FROM worker_heartbeats WHERE started_at >= ?',
      )
      .get(since)?.n ?? 0
  )
}
