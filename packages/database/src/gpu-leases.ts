import type { SQLQueryBindings } from 'bun:sqlite'
import type { Db } from './db'
import { LEASE_IS_LIVE, RENEW_LEASE } from './leases'
import type { GpuLeaseRecord } from './types'

type Params = SQLQueryBindings[]

const LEASE_COLUMNS = `
  resource_id AS resourceId, owner, task_kind AS taskKind,
  lease_expires_at AS leaseExpiresAt, updated_at AS updatedAt
`

export interface AcquireGpuLeaseInput {
  resourceId: string
  owner: string
  taskKind: string
  leaseMs: number
}

/**
 * The whole card is one resource, so ASR and translation cannot hold it at the
 * same time. A lease is taken over only once it expired, and the previous owner
 * is expected to have killed its process before that happens.
 */
export function acquireGpuLease(db: Db, input: AcquireGpuLeaseInput, now: number): boolean {
  return (
    db
      .query<null, Params>(
        `INSERT INTO gpu_leases (resource_id, owner, task_kind, lease_expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (resource_id) DO UPDATE SET
           owner = excluded.owner,
           task_kind = excluded.task_kind,
           lease_expires_at = excluded.lease_expires_at,
           updated_at = excluded.updated_at
         WHERE gpu_leases.lease_expires_at < ? OR gpu_leases.owner = excluded.owner`,
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
         WHERE resource_id = ? AND owner = ? AND ${LEASE_IS_LIVE}`,
      )
      .run(now, now, resourceId, owner, now).changes > 0
  )
}

export function releaseGpuLease(db: Db, resourceId: string, owner: string): boolean {
  return (
    db
      .query<null, Params>('DELETE FROM gpu_leases WHERE resource_id = ? AND owner = ?')
      .run(resourceId, owner).changes > 0
  )
}

export function getGpuLease(db: Db, resourceId: string): GpuLeaseRecord | null {
  return (
    db
      .query<GpuLeaseRecord, Params>(
        `SELECT ${LEASE_COLUMNS} FROM gpu_leases WHERE resource_id = ?`,
      )
      .get(resourceId) ?? null
  )
}
