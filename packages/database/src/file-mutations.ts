import type { SQLQueryBindings } from 'bun:sqlite'
import { newId } from '@mediavault/shared'
import type { Db } from './db'
import type {
  FileMutationRecord,
  FileMutationState,
  MutationAssetRow,
  MutationEventRecord,
} from './types'

type Params = SQLQueryBindings[]

const MUTATION_SELECT = `
  id, kind, asset_id AS assetId, library_id AS libraryId, user_id AS userId,
  request_key AS requestKey, requested_file_version AS requestedFileVersion,
  original_deleted_at AS originalDeletedAt, state, resume_state AS resumeState,
  source_rel AS sourceRel,
  quarantine_rel AS quarantineRel, quarantine_root AS quarantineRoot,
  manifest_json AS manifestJson, attempts, max_attempts AS maxAttempts,
  retry_after AS retryAfter, lease_owner AS leaseOwner, lease_epoch AS leaseEpoch,
  lease_expires_at AS leaseExpiresAt, error_code AS errorCode,
  error_message AS errorMessage, created_at AS createdAt, updated_at AS updatedAt,
  completed_at AS completedAt
`

const ACTIVE_STATES: FileMutationState[] = [
  'requested',
  'validated',
  'quarantined',
  'db_committed',
  'purging',
  'failed_retryable',
]

export const DEFAULT_MUTATION_LEASE_MS = 60_000

export interface MutationLeaseFence {
  workerId: string
  leaseEpoch: number
  now: number
}

export function getFileMutation(db: Db, id: string): FileMutationRecord | null {
  return (
    db.query<FileMutationRecord, Params>(`SELECT ${MUTATION_SELECT} FROM file_mutations WHERE id = ?`).get(id) ??
    null
  )
}

export function getMutationByRequestKey(db: Db, requestKey: string): FileMutationRecord | null {
  return (
    db
      .query<FileMutationRecord, Params>(
        `SELECT ${MUTATION_SELECT} FROM file_mutations WHERE request_key = ?`,
      )
      .get(requestKey) ?? null
  )
}

export function listMutationEvents(db: Db, mutationId: string, limit = 50): MutationEventRecord[] {
  return db
    .query<MutationEventRecord, Params>(
      `SELECT id, mutation_id AS mutationId, state, payload_redacted AS payloadRedacted,
              created_at AS createdAt
       FROM mutation_events WHERE mutation_id = ? ORDER BY id ASC LIMIT ?`,
    )
    .all(mutationId, limit)
}

export function recordMutationEvent(
  db: Db,
  mutationId: string,
  state: FileMutationState,
  payload: Record<string, unknown> | null,
  now: number,
): void {
  db.query<null, Params>(
    `INSERT INTO mutation_events (mutation_id, state, payload_redacted, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(mutationId, state, payload ? JSON.stringify(payload) : null, now)
}

export function getMutationAsset(db: Db, assetId: string): MutationAssetRow | null {
  return (
    db
      .query<MutationAssetRow, Params>(
        `SELECT a.id, a.library_id AS libraryId, a.relative_path AS relativePath,
                a.filename, a.file_version AS fileVersion, a.size_bytes AS sizeBytes,
                a.mtime_ms AS mtimeMs, a.deleted_at AS deletedAt,
                a.pending_delete_mutation_id AS pendingDeleteMutationId,
                l.root_path AS libraryRoot
         FROM assets a JOIN libraries l ON l.id = a.library_id
         WHERE a.id = ?`,
      )
      .get(assetId) ?? null
  )
}

export interface CreateDeleteMutationInput {
  assetId: string
  libraryId: string
  userId: string | null
  requestKey: string
  requestedFileVersion: number
  sourceRel: string
  now: number
}

export interface CreateMutationResult {
  record: FileMutationRecord
  created: boolean
}

/**
 * One request key maps to one mutation forever, so a retried HTTP call returns
 * the original operation instead of queuing a second delete of the same file.
 */
export function createDeleteMutation(db: Db, input: CreateDeleteMutationInput): CreateMutationResult {
  return db.transaction(() => {
    const existing = getMutationByRequestKey(db, input.requestKey)
    if (existing) return { record: existing, created: false }
    const id = newId()
    db.query<null, Params>(
      `INSERT INTO file_mutations (
         id, kind, asset_id, library_id, user_id, request_key, requested_file_version,
         state, source_rel, created_at, updated_at
       ) VALUES (?, 'delete', ?, ?, ?, ?, ?, 'requested', ?, ?, ?)`,
    ).run(
      id,
      input.assetId,
      input.libraryId,
      input.userId,
      input.requestKey,
      input.requestedFileVersion,
      input.sourceRel,
      input.now,
      input.now,
    )
    recordMutationEvent(db, id, 'requested', { kind: 'delete' }, input.now)
    return { record: getFileMutation(db, id)!, created: true }
  }).immediate()
}

export function claimNextMutation(
  db: Db,
  now: number,
  options: { workerId: string; leaseMs?: number } = { workerId: 'mutation-default' },
): FileMutationRecord | null {
  const leaseMs = options.leaseMs ?? DEFAULT_MUTATION_LEASE_MS
  const placeholders = ACTIVE_STATES.map(() => '?').join(',')
  return (
    db
      .query<FileMutationRecord, Params>(
        `UPDATE file_mutations SET
           attempts = attempts + 1,
           lease_owner = ?,
           lease_epoch = lease_epoch + 1,
           lease_expires_at = ?,
           updated_at = ?
         WHERE id = (
           SELECT id FROM file_mutations
           WHERE state IN (${placeholders})
             AND retry_after <= ?
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
           ORDER BY created_at ASC, id ASC
           LIMIT 1
         )
         RETURNING ${MUTATION_SELECT}`,
      )
      .get(options.workerId, now + leaseMs, now, ...ACTIVE_STATES, now, now) ?? null
  )
}

export function heartbeatMutation(
  db: Db,
  id: string,
  fence: MutationLeaseFence,
  leaseMs = DEFAULT_MUTATION_LEASE_MS,
): boolean {
  const result = db
    .query<null, Params>(
      `UPDATE file_mutations SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND lease_owner = ? AND lease_epoch = ? AND lease_expires_at > ?`,
    )
    .run(fence.now + leaseMs, fence.now, id, fence.workerId, fence.leaseEpoch, fence.now)
  return result.changes === 1
}

export function releaseMutationLease(db: Db, id: string, fence: MutationLeaseFence): boolean {
  const result = db
    .query<null, Params>(
      `UPDATE file_mutations SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND lease_owner = ? AND lease_epoch = ? AND lease_expires_at > ?`,
    )
    .run(fence.now, id, fence.workerId, fence.leaseEpoch, fence.now)
  return result.changes === 1
}

export interface TransitionPatch {
  state: FileMutationState
  resumeState?: FileMutationState | null
  quarantineRel?: string | null
  quarantineRoot?: string | null
  manifestJson?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  retryAfter?: number
  completedAt?: number | null
  originalDeletedAt?: number | null
  event?: Record<string, unknown> | null
}

/**
 * Every state change is fenced on the lease that produced it, so a worker that
 * lost its lease can never overwrite a newer worker's progress.
 */
export function transitionMutation(
  db: Db,
  id: string,
  fence: MutationLeaseFence,
  patch: TransitionPatch,
): boolean {
  return db.transaction(() => {
    const result = db
      .query<null, Params>(
        `UPDATE file_mutations SET
           state = ?,
           resume_state = ?,
           quarantine_rel = COALESCE(?, quarantine_rel),
           quarantine_root = COALESCE(?, quarantine_root),
           manifest_json = COALESCE(?, manifest_json),
           error_code = ?,
           error_message = ?,
           retry_after = ?,
           completed_at = COALESCE(?, completed_at),
           original_deleted_at = COALESCE(?, original_deleted_at),
           updated_at = ?
         WHERE id = ? AND lease_owner = ? AND lease_epoch = ? AND lease_expires_at > ?`,
      )
      .run(
        patch.state,
        patch.resumeState ?? null,
        patch.quarantineRel ?? null,
        patch.quarantineRoot ?? null,
        patch.manifestJson ?? null,
        patch.errorCode ?? null,
        patch.errorMessage ?? null,
        patch.retryAfter ?? 0,
        patch.completedAt ?? null,
        patch.originalDeletedAt ?? null,
        fence.now,
        id,
        fence.workerId,
        fence.leaseEpoch,
        fence.now,
      )
    if (result.changes !== 1) return false
    recordMutationEvent(db, id, patch.state, patch.event ?? null, fence.now)
    return true
  }).immediate()
}

/**
 * Hides the asset and records which mutation owns the tombstone. The compare
 * and set refuses to touch an asset that another mutation already owns or that
 * the scanner soft-deleted on its own, and it requires the caller's lease to
 * still be live so a worker that lost its lease cannot hide anything.
 */
export function markAssetPendingDelete(
  db: Db,
  assetId: string,
  mutationId: string,
  expectedFileVersion: number,
  fence: MutationLeaseFence,
): boolean {
  const result = db
    .query<null, Params>(
      `UPDATE assets SET pending_delete_mutation_id = ?, deleted_at = ?
       WHERE id = ? AND deleted_at IS NULL AND pending_delete_mutation_id IS NULL
         AND file_version = ?
         AND EXISTS (
           SELECT 1 FROM file_mutations
           WHERE id = ? AND lease_owner = ? AND lease_epoch = ? AND lease_expires_at > ?
         )`,
    )
    .run(
      mutationId,
      fence.now,
      assetId,
      expectedFileVersion,
      mutationId,
      fence.workerId,
      fence.leaseEpoch,
      fence.now,
    )
  return result.changes === 1
}

export function clearAssetPendingDelete(db: Db, assetId: string, mutationId: string): boolean {
  const result = db
    .query<null, Params>(
      `UPDATE assets SET pending_delete_mutation_id = NULL, deleted_at = NULL
       WHERE id = ? AND pending_delete_mutation_id = ?`,
    )
    .run(assetId, mutationId)
  return result.changes === 1
}

/**
 * Puts a failed mutation back in the queue with a fresh attempt budget. Refused
 * while a worker still holds the lease, so a retry cannot race an execution.
 */
export function retryFileMutation(db: Db, id: string, now: number): boolean {
  return db.transaction(() => {
    const result = db
      .query<null, Params>(
        `UPDATE file_mutations SET
           state = COALESCE(resume_state, 'requested'),
           resume_state = NULL,
           retry_after = 0,
           error_code = NULL,
           error_message = NULL,
           attempts = 0,
           updated_at = ?
         WHERE id = ? AND state = 'failed_retryable'
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .run(now, id, now)
    if (result.changes !== 1) return false
    recordMutationEvent(db, id, 'requested', { retriedBy: 'api' }, now)
    return true
  }).immediate()
}
