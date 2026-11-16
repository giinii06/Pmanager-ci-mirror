import type { SQLQueryBindings } from 'bun:sqlite'
import type { Db } from './db'
import { LEASE_IS_LIVE, RENEW_LEASE } from './leases'
import type { GpuLeaseRecord } from './types'

type Params = SQLQueryBindings[]

const LEASE_COLUMNS = `
  resource_id AS resourceId, owner, task_kind AS taskKind,
  lease_expires_at AS leaseExpiresAt, updated_at AS updatedAt
`

/**
 * How long the kind that just released the card waits before it takes it again.
 * Every GPU worker retries on a five-second timer, so this leaves three chances
 * for a kind that was waiting.
 */
const YIELD_MS = 15_000

/** The kinds that compete for the card, and what "still has work" means for each. */
const WAITING: Array<{ kind: string; sql: string }> = [
  {
    kind: 'asr',
    sql: `SELECT 1 AS waiting FROM asr_jobs
          WHERE state IN ('queued','transcribing','aligning','writing') LIMIT 1`,
  },
  {
    kind: 'translation',
    sql: `SELECT 1 AS waiting FROM translation_jobs
          WHERE state IN ('queued','translating','writing') LIMIT 1`,
  },
  {
    kind: 'embedding',
    sql: `SELECT 1 AS waiting FROM embedding_jobs
          WHERE state IN ('queued','embedding','writing') LIMIT 1`,
  },
  {
    kind: 'scene',
    sql: `SELECT 1 AS waiting FROM scene_jobs
          WHERE state IN ('queued','extracting','embedding','writing') LIMIT 1`,
  },
]

export interface AcquireGpuLeaseInput {
  resourceId: string
  owner: string
  taskKind: string
  leaseMs: number
}

function competesForCard(taskKind: string): boolean {
  return WAITING.some((queue) => queue.kind === taskKind)
}

function anotherKindWaits(db: Db, taskKind: string): boolean {
  return WAITING.some((queue) => {
    if (queue.kind === taskKind) return false
    return db.query<{ waiting: number }, []>(queue.sql).get() !== null
  })
}

/**
 * The kind that released the card last steps back for one turn while another
 * kind has work waiting. Without this a worker that finishes a job re-acquires
 * within the same millisecond it releases, and the other kinds never see a free
 * card — the scene worker alone kept ASR out for hours.
 *
 * The wait is bounded by `YIELD_MS`, so a queue whose worker is down costs the
 * releasing kind a pause instead of blocking it forever.
 */
function yieldsToAnotherKind(db: Db, input: AcquireGpuLeaseInput, now: number): boolean {
  if (!competesForCard(input.taskKind)) return false

  const released = db
    .query<{ taskKind: string; releasedAt: number }, Params>(
      `SELECT task_kind AS taskKind, released_at AS releasedAt FROM gpu_leases
       WHERE resource_id = ? AND released_at IS NOT NULL`,
    )
    .get(input.resourceId)
  if (!released || released.taskKind !== input.taskKind) return false
  if (now - released.releasedAt >= YIELD_MS) return false

  return anotherKindWaits(db, input.taskKind)
}

/**
 * The whole card is one resource, so ASR and translation cannot hold it at the
 * same time. A lease is taken over only once it expired or was released, and the
 * previous owner is expected to have killed its process before that happens.
 */
export function acquireGpuLease(db: Db, input: AcquireGpuLeaseInput, now: number): boolean {
  if (yieldsToAnotherKind(db, input, now)) return false

  return (
    db
      .query<null, Params>(
        `INSERT INTO gpu_leases
           (resource_id, owner, task_kind, lease_expires_at, updated_at, released_at)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT (resource_id) DO UPDATE SET
           owner = excluded.owner,
           task_kind = excluded.task_kind,
           lease_expires_at = excluded.lease_expires_at,
           updated_at = excluded.updated_at,
           released_at = NULL
         WHERE gpu_leases.lease_expires_at < ?
            OR gpu_leases.owner = excluded.owner
            OR gpu_leases.released_at IS NOT NULL`,
      )
      .run(
        input.resourceId,
        input.owner,
        input.taskKind,
        now + input.leaseMs,
        now,
        now,
      ).changes > 0
  )
}

/**
 * Returns false once the lease expired, so the owner can stop its process
 * instead of writing into a card another job may already hold.
 */
export function heartbeatGpuLease(db: Db, resourceId: string, owner: string, now: number): boolean {
  return (
    db
      .query<null, Params>(
        `UPDATE gpu_leases SET ${RENEW_LEASE}
         WHERE resource_id = ? AND owner = ? AND released_at IS NULL AND ${LEASE_IS_LIVE}`,
      )
      .run(now, now, resourceId, owner, now).changes > 0
  )
}

/**
 * Marks the row released instead of deleting it, so the next acquire can tell
 * that this kind just had a turn.
 */
export function releaseGpuLease(db: Db, resourceId: string, owner: string, now: number): boolean {
  return (
    db
      .query<null, Params>(
        `UPDATE gpu_leases SET released_at = ?, lease_expires_at = ?, updated_at = ?
         WHERE resource_id = ? AND owner = ? AND released_at IS NULL`,
      )
      .run(now, now, now, resourceId, owner).changes > 0
  )
}

/** The lease in force now; a released row is not one. */
export function getGpuLease(db: Db, resourceId: string): GpuLeaseRecord | null {
  return (
    db
      .query<GpuLeaseRecord, Params>(
        `SELECT ${LEASE_COLUMNS} FROM gpu_leases
         WHERE resource_id = ? AND released_at IS NULL`,
      )
      .get(resourceId) ?? null
  )
}
