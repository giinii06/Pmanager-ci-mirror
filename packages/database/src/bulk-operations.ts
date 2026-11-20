import type { SQLQueryBindings } from 'bun:sqlite'
import { newId } from '@mediavault/shared'
import type { Db } from './db'
import type {
  BulkErrorGroup,
  BulkItemState,
  BulkOperationCounts,
  BulkOperationItemRecord,
  BulkOperationKind,
  BulkOperationRecord,
  BulkOperationState,
} from './types'

type Params = SQLQueryBindings[]

const OPERATION_SELECT = `
  id, user_id AS userId, kind, selection_kind AS selectionKind,
  selection_json AS selectionJson, snapshot_count AS snapshotCount,
  snapshot_hash AS snapshotHash, snapshot_generation AS snapshotGeneration,
  params_json AS paramsJson, state, request_key AS requestKey,
  attempts, max_attempts AS maxAttempts, retry_after AS retryAfter,
  lease_owner AS leaseOwner, lease_epoch AS leaseEpoch,
  lease_expires_at AS leaseExpiresAt, error_code AS errorCode,
  error_message AS errorMessage, created_at AS createdAt,
  updated_at AS updatedAt, completed_at AS completedAt
`

const ITEM_SELECT = `
  id, operation_id AS operationId, asset_id AS assetId, position, filename,
  relative_path AS relativePath, size_bytes AS sizeBytes, state,
  mutation_id AS mutationId, error_code AS errorCode, error_message AS errorMessage,
  attempts, updated_at AS updatedAt
`

/** A running row whose lease expired is claimable again, like the mutation loop. */
const ACTIVE_OPERATION_STATES: BulkOperationState[] = ['queued', 'running', 'cancelling']

export const DEFAULT_BULK_LEASE_MS = 60_000

export interface BulkOperationLeaseFence {
  workerId: string
  leaseEpoch: number
  now: number
}

export interface BulkSelectionItem {
  assetId: string
  filename: string
  relativePath: string
  sizeBytes: number
}

export interface CreateBulkOperationInput {
  id: string
  userId: string
  kind: BulkOperationKind
  selectionKind: 'ids' | 'query'
  selectionJson: string
  snapshotCount: number
  snapshotHash: string
  snapshotGeneration: string
  paramsJson: string
  requestKey: string
  items: BulkSelectionItem[]
  now: number
}

export interface CreateBulkOperationResult {
  record: BulkOperationRecord
  created: boolean
}

export function getBulkOperation(db: Db, id: string, userId?: string): BulkOperationRecord | null {
  if (userId === undefined) {
    return (
      db
        .query<BulkOperationRecord, Params>(`SELECT ${OPERATION_SELECT} FROM bulk_operations WHERE id = ?`)
        .get(id) ?? null
    )
  }
  return (
    db
      .query<BulkOperationRecord, Params>(
        `SELECT ${OPERATION_SELECT} FROM bulk_operations WHERE id = ? AND user_id = ?`,
      )
      .get(id, userId) ?? null
  )
}

export function getBulkOperationByRequestKey(db: Db, requestKey: string): BulkOperationRecord | null {
  return (
    db
      .query<BulkOperationRecord, Params>(
        `SELECT ${OPERATION_SELECT} FROM bulk_operations WHERE request_key = ?`,
      )
      .get(requestKey) ?? null
  )
}

/**
 * The parent and its frozen target set are created in one transaction, so an
 * operation never exists with a partial item list. The work itself is not one
 * transaction: each item commits its own state as it finishes.
 */
export function createBulkOperation(
  db: Db,
  input: CreateBulkOperationInput,
): CreateBulkOperationResult {
  return db.transaction(() => {
    const existing = getBulkOperationByRequestKey(db, input.requestKey)
    if (existing) return { record: existing, created: false }

    db.query<null, Params>(
      `INSERT INTO bulk_operations (
         id, user_id, kind, selection_kind, selection_json, snapshot_count,
         snapshot_hash, snapshot_generation, params_json, state, request_key,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    ).run(
      input.id,
      input.userId,
      input.kind,
      input.selectionKind,
      input.selectionJson,
      input.snapshotCount,
      input.snapshotHash,
      input.snapshotGeneration,
      input.paramsJson,
      input.requestKey,
      input.now,
      input.now,
    )

    const statement = db.query<null, Params>(
      `INSERT INTO bulk_operation_items (
         id, operation_id, asset_id, position, filename, relative_path,
         size_bytes, state, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    input.items.forEach((item, index) => {
      statement.run(
        newId(),
        input.id,
        item.assetId,
        index,
        item.filename,
        item.relativePath,
        item.sizeBytes,
        input.now,
      )
    })

    return { record: getBulkOperation(db, input.id)!, created: true }
  }).immediate()
}

export function getBulkOperationCounts(db: Db, id: string): BulkOperationCounts {
  const row = db
    .query<
      {
        total: number
        pending: number
        running: number
        succeeded: number
        failed: number
        held: number
        cancelled: number
      },
      Params
    >(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
         COALESCE(SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END), 0) AS running,
         COALESCE(SUM(CASE WHEN state = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded,
         COALESCE(SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
         COALESCE(SUM(CASE WHEN state = 'held' THEN 1 ELSE 0 END), 0) AS held,
         COALESCE(SUM(CASE WHEN state = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled
       FROM bulk_operation_items WHERE operation_id = ?`,
    )
    .get(id)
  return (
    row ?? { total: 0, pending: 0, running: 0, succeeded: 0, failed: 0, held: 0, cancelled: 0 }
  )
}

export function getBulkOperationErrorGroups(db: Db, id: string): BulkErrorGroup[] {
  return db
    .query<BulkErrorGroup, Params>(
      `SELECT COALESCE(error_code, 'unknown') AS code,
              COALESCE(error_message, '') AS message,
              COUNT(*) AS count
       FROM bulk_operation_items
       WHERE operation_id = ? AND state IN ('failed','held')
       GROUP BY code, message
       ORDER BY count DESC, code ASC
       LIMIT 20`,
    )
    .all(id)
}

export function listBulkOperationItems(
  db: Db,
  operationId: string,
  options: { state?: BulkItemState; limit?: number; offset?: number } = {},
): BulkOperationItemRecord[] {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
  const offset = Math.max(options.offset ?? 0, 0)
  if (options.state) {
    return db
      .query<BulkOperationItemRecord, Params>(
        `SELECT ${ITEM_SELECT} FROM bulk_operation_items
         WHERE operation_id = ? AND state = ? ORDER BY position LIMIT ? OFFSET ?`,
      )
      .all(operationId, options.state, limit, offset)
  }
  return db
    .query<BulkOperationItemRecord, Params>(
      `SELECT ${ITEM_SELECT} FROM bulk_operation_items
       WHERE operation_id = ? ORDER BY position LIMIT ? OFFSET ?`,
    )
    .all(operationId, limit, offset)
}

export interface BulkOperationSummary {
  record: BulkOperationRecord
  counts: BulkOperationCounts
}

/**
 * Counts target paths that already belong to an asset. A preview reports the
 * number so the user can pick another folder before anything is queued. The
 * chunks keep the bound-parameter count well under SQLite's limit.
 */
export function countTargetCollisions(
  db: Db,
  libraryId: string,
  paths: string[],
  chunkSize = 400,
): number {
  let count = 0
  for (let index = 0; index < paths.length; index += chunkSize) {
    const chunk = paths.slice(index, index + chunkSize)
    if (chunk.length === 0) continue
    const placeholders = chunk.map(() => '?').join(',')
    count +=
      db
        .query<{ n: number }, Params>(
          `SELECT COUNT(*) AS n FROM assets
           WHERE library_id = ? AND deleted_at IS NULL AND relative_path IN (${placeholders})`,
        )
        .get(libraryId, ...chunk)?.n ?? 0
  }
  return count
}

export function listBulkOperations(db: Db, userId: string, limit = 20): BulkOperationSummary[] {
  const rows = db
    .query<BulkOperationRecord, Params>(
      `SELECT ${OPERATION_SELECT} FROM bulk_operations
       WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(userId, Math.min(Math.max(limit, 1), 100))
  return rows.map((record) => ({
    record,
    counts: getBulkOperationCounts(db, record.id),
  }))
}

export function claimNextBulkOperation(
  db: Db,
  now: number,
  options: { workerId: string; leaseMs?: number } = { workerId: 'bulk-default' },
): BulkOperationRecord | null {
  const leaseMs = options.leaseMs ?? DEFAULT_BULK_LEASE_MS
  const placeholders = ACTIVE_OPERATION_STATES.map(() => '?').join(',')
  return (
    db
      .query<BulkOperationRecord, Params>(
        `UPDATE bulk_operations SET
           attempts = attempts + 1,
           lease_owner = ?,
           lease_epoch = lease_epoch + 1,
           lease_expires_at = ?,
           updated_at = ?
         WHERE id = (
           SELECT id FROM bulk_operations
           WHERE state IN (${placeholders})
             AND retry_after <= ?
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
           ORDER BY created_at ASC, id ASC
           LIMIT 1
         )
         RETURNING ${OPERATION_SELECT}`,
      )
      .get(options.workerId, now + leaseMs, now, ...ACTIVE_OPERATION_STATES, now, now) ?? null
  )
}

export function heartbeatBulkOperation(
  db: Db,
  id: string,
  fence: BulkOperationLeaseFence,
  leaseMs = DEFAULT_BULK_LEASE_MS,
): boolean {
  const result = db
    .query<null, Params>(
      `UPDATE bulk_operations SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND lease_owner = ? AND lease_epoch = ? AND lease_expires_at > ?`,
    )
    .run(fence.now + leaseMs, fence.now, id, fence.workerId, fence.leaseEpoch, fence.now)
  return result.changes === 1
}

export function releaseBulkLease(db: Db, id: string, fence: BulkOperationLeaseFence): boolean {
  const result = db
    .query<null, Params>(
      `UPDATE bulk_operations SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND lease_owner = ? AND lease_epoch = ? AND lease_expires_at > ?`,
    )
    .run(fence.now, id, fence.workerId, fence.leaseEpoch, fence.now)
  return result.changes === 1
}

export interface BulkTransitionPatch {
  state: BulkOperationState
  errorCode?: string | null
  errorMessage?: string | null
  retryAfter?: number
  completedAt?: number | null
}

/** Every state change is fenced on the lease that produced it. */
export function transitionBulkOperation(
  db: Db,
  id: string,
  fence: BulkOperationLeaseFence,
  patch: BulkTransitionPatch,
): boolean {
  const result = db
    .query<null, Params>(
      `UPDATE bulk_operations SET
         state = ?, error_code = ?, error_message = ?, retry_after = ?,
         completed_at = COALESCE(?, completed_at), updated_at = ?
       WHERE id = ? AND lease_owner = ? AND lease_epoch = ? AND lease_expires_at > ?`,
    )
    .run(
      patch.state,
      patch.errorCode ?? null,
      patch.errorMessage ?? null,
      patch.retryAfter ?? 0,
      patch.completedAt ?? null,
      fence.now,
      id,
      fence.workerId,
      fence.leaseEpoch,
      fence.now,
    )
  return result.changes === 1
}

export function claimNextBulkItem(
  db: Db,
  operationId: string,
  now: number,
): BulkOperationItemRecord | null {
  return (
    db
      .query<BulkOperationItemRecord, Params>(
        `UPDATE bulk_operation_items SET state = 'running', attempts = attempts + 1, updated_at = ?
         WHERE id = (
           SELECT id FROM bulk_operation_items
           WHERE operation_id = ? AND state = 'pending'
           ORDER BY position ASC
           LIMIT 1
         )
         RETURNING ${ITEM_SELECT}`,
      )
      .get(now, operationId) ?? null
  )
}

export function finishBulkItem(
  db: Db,
  itemId: string,
  state: Exclude<BulkItemState, 'pending' | 'running'>,
  error: { code?: string | null; message?: string | null } | null,
  now: number,
): boolean {
  const result = db
    .query<null, Params>(
      `UPDATE bulk_operation_items SET
         state = ?, error_code = ?, error_message = ?, updated_at = ?
       WHERE id = ? AND state = 'running'`,
    )
    .run(state, error?.code ?? null, error?.message?.slice(0, 500) ?? null, now, itemId)
  return result.changes === 1
}

export function attachBulkItemMutation(
  db: Db,
  itemId: string,
  mutationId: string,
  now: number,
): boolean {
  const result = db
    .query<null, Params>(
      `UPDATE bulk_operation_items SET mutation_id = ?, updated_at = ?
       WHERE id = ? AND state = 'running'`,
    )
    .run(mutationId, now, itemId)
  return result.changes === 1
}

/** An inline item has no durable sub-operation, so a restart makes it pending again. */
export function resetInlineRunningItems(db: Db, operationId: string, now: number): number {
  const result = db
    .query<null, Params>(
      `UPDATE bulk_operation_items SET state = 'pending', updated_at = ?
       WHERE operation_id = ? AND state = 'running' AND mutation_id IS NULL`,
    )
    .run(now, operationId)
  return result.changes
}

export function listRunningBulkItems(db: Db, operationId: string): BulkOperationItemRecord[] {
  return db
    .query<BulkOperationItemRecord, Params>(
      `SELECT ${ITEM_SELECT} FROM bulk_operation_items
       WHERE operation_id = ? AND state = 'running' ORDER BY position`,
    )
    .all(operationId)
}

export function cancelPendingBulkItems(db: Db, operationId: string, now: number): number {
  const result = db
    .query<null, Params>(
      `UPDATE bulk_operation_items SET
         state = 'cancelled', error_code = 'cancelled_by_user',
         error_message = 'The operation was cancelled before this file was started.', updated_at = ?
       WHERE operation_id = ? AND state = 'pending'`,
    )
    .run(now, operationId)
  return result.changes
}

export type BulkCancelResult = 'cancelled' | 'cancelling' | 'not_active' | 'missing'

/**
 * Cancels only what has not started. Pending items stop here; a running item
 * is left for the worker to stop at its last safe step. A committed delete is
 * never reported as undone.
 */
export function requestBulkCancel(
  db: Db,
  id: string,
  userId: string,
  now: number,
): BulkCancelResult {
  return db.transaction(() => {
    const operation = getBulkOperation(db, id, userId)
    if (!operation) return 'missing'
    if (
      operation.state !== 'queued' &&
      operation.state !== 'running' &&
      operation.state !== 'cancelling'
    ) {
      return 'not_active'
    }
    cancelPendingBulkItems(db, id, now)
    const counts = getBulkOperationCounts(db, id)
    const next: BulkOperationState = counts.running > 0 ? 'cancelling' : 'cancelled'
    db.query<null, Params>(
      `UPDATE bulk_operations SET state = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
    ).run(next, next === 'cancelled' ? now : null, now, id)
    return next === 'cancelled' ? 'cancelled' : 'cancelling'
  }).immediate()
}

/**
 * Puts failed and held items back in the queue. The parent must not be held by
 * a worker. A file item's blocked mutation keeps the bulk request key, so that
 * key is moved aside first; otherwise the retried item would receive the old
 * blocked row instead of a new attempt.
 */
export function retryBulkItems(
  db: Db,
  id: string,
  userId: string,
  itemIds: string[] | null,
  now: number,
): number | null {
  return db.transaction(() => {
    const operation = getBulkOperation(db, id, userId)
    if (!operation) return null
    if (operation.leaseExpiresAt !== null && operation.leaseExpiresAt > now) return null
    if (
      operation.state !== 'completed' &&
      operation.state !== 'completed_with_errors' &&
      operation.state !== 'cancelled' &&
      operation.state !== 'failed'
    ) {
      return null
    }

    const scoped = itemIds !== null && itemIds.length > 0
    const scope = scoped ? `AND id IN (${itemIds.map(() => '?').join(',')})` : ''
    const scopeParams = scoped ? itemIds : []

    db.query<null, Params>(
      `UPDATE file_mutations SET request_key = request_key || ':retry:' || id
       WHERE id IN (
         SELECT mutation_id FROM bulk_operation_items
         WHERE operation_id = ? AND state IN ('failed','held')
           AND mutation_id IS NOT NULL ${scope}
       )
       AND (state IN ('blocked','cancelled_pre_commit')
            OR (state = 'failed_retryable' AND attempts >= max_attempts))`,
    ).run(id, ...scopeParams)

    const result = db
      .query<null, Params>(
        `UPDATE bulk_operation_items SET
           state = 'pending', attempts = 0, mutation_id = NULL,
           error_code = NULL, error_message = NULL, updated_at = ?
         WHERE operation_id = ? AND state IN ('failed','held') ${scope}`,
      )
      .run(now, id, ...scopeParams)
    const reset = result.changes
    if (reset === 0) return 0

    db.query<null, Params>(
      `UPDATE bulk_operations SET
         state = 'queued', attempts = 0, retry_after = 0,
         error_code = NULL, error_message = NULL, completed_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(now, id)
    return reset
  }).immediate()
}
