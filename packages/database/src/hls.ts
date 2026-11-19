import type { SQLQueryBindings } from 'bun:sqlite'
import { newId, type Priority } from '@mediavault/shared'
import type { Db } from './db'
import { enqueueJob, getJob } from './jobs'
import type { HlsActiveRecord, HlsGenerationRecord } from './types'

type Params = SQLQueryBindings[]

export const HLS_GC_GRACE_MS = 24 * 60 * 60_000
export const HLS_ACCESS_TOUCH_MS = 120_000

const GENERATION_SELECT = `
  id, asset_id AS assetId, file_version AS fileVersion, profile_hash AS profileHash,
  state, stage, progress, storage_rel AS storageRel, playlist_rel AS playlistRel,
  job_id AS jobId, worker_id AS workerId, lease_epoch AS leaseEpoch,
  request_seq AS requestSeq, encoder, created_at AS createdAt, updated_at AS updatedAt,
  published_at AS publishedAt, superseded_at AS supersededAt,
  eligible_for_gc_at AS eligibleForGcAt, last_access_at AS lastAccessAt,
  error_code AS errorCode, error_message AS errorMessage
`

export function getHlsGeneration(db: Db, id: string): HlsGenerationRecord | null {
  return (
    db
      .query<HlsGenerationRecord, Params>(`SELECT ${GENERATION_SELECT} FROM hls_generations WHERE id = ?`)
      .get(id) ?? null
  )
}

export function getHlsActive(
  db: Db,
  assetId: string,
  fileVersion: number,
  profileHash: string,
): HlsActiveRecord | null {
  return (
    db
      .query<HlsActiveRecord, Params>(
        `SELECT asset_id AS assetId, file_version AS fileVersion, profile_hash AS profileHash,
                generation_id AS generationId, request_seq AS requestSeq, updated_at AS updatedAt
         FROM hls_active
         WHERE asset_id = ? AND file_version = ? AND profile_hash = ?`,
      )
      .get(assetId, fileVersion, profileHash) ?? null
  )
}

export function findPendingHlsGeneration(
  db: Db,
  assetId: string,
  fileVersion: number,
  profileHash: string,
): HlsGenerationRecord | null {
  return (
    db
      .query<HlsGenerationRecord, Params>(
        `SELECT ${GENERATION_SELECT} FROM hls_generations
         WHERE asset_id = ? AND file_version = ? AND profile_hash = ?
           AND state IN ('queued','running','retry_wait')
         ORDER BY request_seq DESC LIMIT 1`,
      )
      .get(assetId, fileVersion, profileHash) ?? null
  )
}

export function getLatestHlsGeneration(
  db: Db,
  assetId: string,
  fileVersion: number,
  profileHash: string,
): HlsGenerationRecord | null {
  return (
    db
      .query<HlsGenerationRecord, Params>(
        `SELECT ${GENERATION_SELECT} FROM hls_generations
         WHERE asset_id = ? AND file_version = ? AND profile_hash = ?
         ORDER BY request_seq DESC LIMIT 1`,
      )
      .get(assetId, fileVersion, profileHash) ?? null
  )
}

export function hlsDedupeKey(assetId: string, fileVersion: number, profileHash: string): string {
  return `hls:${assetId}:${fileVersion}:${profileHash}`
}

function activeJobId(db: Db, dedupeKey: string): number | null {
  const row = db
    .query<{ id: number }, Params>(
      `SELECT id FROM jobs
       WHERE dedupe_key = ? AND state IN ('queued','running','paused')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(dedupeKey)
  return row?.id ?? null
}

function enqueueGenerationJob(
  db: Db,
  generation: HlsGenerationRecord,
  priority: Priority,
  now: number,
): number {
  const dedupeKey = hlsDedupeKey(generation.assetId, generation.fileVersion, generation.profileHash)
  enqueueJob(
    db,
    {
      dedupeKey,
      kind: 'hls',
      priority,
      assetId: generation.assetId,
      payload: { generationId: generation.id },
    },
    now,
  )
  const jobId = activeJobId(db, dedupeKey)
  if (jobId === null) throw new Error(`hls job for ${generation.id} was not queued`)
  db.query<null, Params>('UPDATE hls_generations SET job_id = ?, updated_at = ? WHERE id = ?').run(
    jobId,
    now,
    generation.id,
  )
  return jobId
}

export interface CreateHlsRequestInput {
  assetId: string
  fileVersion: number
  profileHash: string
  priority: Priority
  now: number
}

export interface CreateHlsRequestResult {
  generation: HlsGenerationRecord
  created: boolean
}

/**
 * One pending generation per asset/version/profile. A ready active generation
 * is reused as-is; a pending one keeps its id so every caller observes the
 * same operation, and a pending row whose job died gets a fresh job instead of
 * waiting forever.
 */
export function createHlsRequest(db: Db, input: CreateHlsRequestInput): CreateHlsRequestResult {
  return db.transaction(() => {
    const pending = findPendingHlsGeneration(db, input.assetId, input.fileVersion, input.profileHash)
    if (pending) {
      const job = pending.jobId === null ? null : getJob(db, pending.jobId)
      if (!job || (job.state !== 'queued' && job.state !== 'running' && job.state !== 'paused')) {
        enqueueGenerationJob(db, pending, input.priority, input.now)
      }
      return { generation: getHlsGeneration(db, pending.id)!, created: false }
    }

    const active = getHlsActive(db, input.assetId, input.fileVersion, input.profileHash)
    if (active) {
      const generation = getHlsGeneration(db, active.generationId)
      if (generation?.state === 'ready') return { generation, created: false }
    }

    const seq = db
      .query<{ seq: number }, Params>(
        `SELECT COALESCE(MAX(request_seq), 0) + 1 AS seq FROM hls_generations
         WHERE asset_id = ? AND file_version = ? AND profile_hash = ?`,
      )
      .get(input.assetId, input.fileVersion, input.profileHash)!.seq
    const id = newId()
    db.query<null, Params>(
      `INSERT INTO hls_generations (
         id, asset_id, file_version, profile_hash, state, stage, progress,
         request_seq, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'queued', 'queued', 0, ?, ?, ?)`,
    ).run(id, input.assetId, input.fileVersion, input.profileHash, seq, input.now, input.now)
    const generation = getHlsGeneration(db, id)!
    enqueueGenerationJob(db, generation, input.priority, input.now)
    return { generation: getHlsGeneration(db, id)!, created: true }
  }).immediate()
}

export interface HlsJobFence {
  workerId: string
  leaseEpoch: number
  jobId: number
  now: number
}

export function isHlsJobLeaseLive(db: Db, fence: HlsJobFence): boolean {
  const job = getJob(db, fence.jobId)
  return (
    job !== null &&
    job.state === 'running' &&
    job.workerId === fence.workerId &&
    job.leaseEpoch === fence.leaseEpoch &&
    job.leaseExpiresAt !== null &&
    job.leaseExpiresAt > fence.now
  )
}

/**
 * Adopts a queued, retrying, or previously owned generation for this job lease.
 * The job row is the only lease authority; the generation mirrors it.
 */
export function claimHlsGeneration(db: Db, id: string, fence: HlsJobFence): boolean {
  if (!isHlsJobLeaseLive(db, fence)) return false
  const result = db
    .query<null, Params>(
      `UPDATE hls_generations SET
         state = 'running', stage = 'encoding', worker_id = ?, lease_epoch = ?,
         job_id = ?, error_code = NULL, error_message = NULL, updated_at = ?
       WHERE id = ? AND state IN ('queued','running','retry_wait')
         AND EXISTS (
           SELECT 1 FROM jobs
           WHERE id = ? AND state = 'running' AND worker_id = ? AND lease_epoch = ?
             AND lease_expires_at > ?
         )`,
    )
    .run(
      fence.workerId,
      fence.leaseEpoch,
      fence.jobId,
      fence.now,
      id,
      fence.jobId,
      fence.workerId,
      fence.leaseEpoch,
      fence.now,
    )
  return result.changes === 1
}

/** Progress never moves backwards and never claims completion. */
export function updateHlsProgress(
  db: Db,
  id: string,
  fence: HlsJobFence,
  progress: number,
  stage: string,
): boolean {
  const clamped = Math.max(0, Math.min(99, Math.round(progress)))
  const result = db
    .query<null, Params>(
      `UPDATE hls_generations SET progress = MAX(progress, ?), stage = ?, updated_at = ?
       WHERE id = ? AND state = 'running' AND worker_id = ? AND lease_epoch = ?`,
    )
    .run(clamped, stage, fence.now, id, fence.workerId, fence.leaseEpoch)
  return result.changes === 1
}

export function failHlsGeneration(
  db: Db,
  id: string,
  fence: HlsJobFence,
  outcome: { state: 'failed' | 'retry_wait' | 'cancelled'; errorCode: string; errorMessage: string },
): boolean {
  const result = db
    .query<null, Params>(
      `UPDATE hls_generations SET state = ?, stage = NULL, error_code = ?, error_message = ?,
         updated_at = ?
       WHERE id = ? AND state = 'running' AND worker_id = ? AND lease_epoch = ?`,
    )
    .run(
      outcome.state,
      outcome.errorCode,
      outcome.errorMessage.slice(0, 500),
      fence.now,
      id,
      fence.workerId,
      fence.leaseEpoch,
    )
  return result.changes === 1
}

export interface PublishHlsInput {
  id: string
  fence: HlsJobFence
  storageRel: string
  playlistRel: string
  encoder: string
  graceMs: number
}

export interface PublishHlsResult {
  published: boolean
  activated: boolean
}

/**
 * The filesystem rename happens before this call. This transaction is the
 * activation point: it re-checks the live job lease, the asset's version and
 * delete ownership, and only then makes the generation visible. A loser must
 * delete its own attempt directory and never the winner's.
 */
export function publishHlsGeneration(db: Db, input: PublishHlsInput): PublishHlsResult {
  return db.transaction(() => {
    const generation = getHlsGeneration(db, input.id)
    if (!generation || generation.state !== 'running') return { published: false, activated: false }
    if (!isHlsJobLeaseLive(db, input.fence)) return { published: false, activated: false }

    const asset = db
      .query<{ fileVersion: number; deletedAt: number | null; pendingDelete: string | null }, Params>(
        `SELECT file_version AS fileVersion, deleted_at AS deletedAt,
                pending_delete_mutation_id AS pendingDelete
         FROM assets WHERE id = ?`,
      )
      .get(generation.assetId)
    if (!asset || asset.deletedAt !== null || asset.pendingDelete !== null) {
      return { published: false, activated: false }
    }
    if (asset.fileVersion !== generation.fileVersion) return { published: false, activated: false }

    const updated = db
      .query<null, Params>(
        `UPDATE hls_generations SET
           state = 'ready', stage = NULL, progress = 100, storage_rel = ?, playlist_rel = ?,
           encoder = ?, published_at = ?, error_code = NULL, error_message = NULL, updated_at = ?
         WHERE id = ? AND state = 'running' AND worker_id = ? AND lease_epoch = ?`,
      )
      .run(
        input.storageRel,
        input.playlistRel,
        input.encoder,
        input.fence.now,
        input.fence.now,
        input.id,
        input.fence.workerId,
        input.fence.leaseEpoch,
      )
    if (updated.changes !== 1) return { published: false, activated: false }

    const active = getHlsActive(db, generation.assetId, generation.fileVersion, generation.profileHash)
    const newerActive = active !== null && active.requestSeq > generation.requestSeq
    if (newerActive) {
      db.query<null, Params>(
        `UPDATE hls_generations SET superseded_at = ?, eligible_for_gc_at = ? WHERE id = ?`,
      ).run(input.fence.now, input.fence.now + input.graceMs, generation.id)
      return { published: true, activated: false }
    }

    db.query<null, Params>(
      `INSERT INTO hls_active (
         asset_id, file_version, profile_hash, generation_id, request_seq, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(asset_id, file_version, profile_hash) DO UPDATE SET
         generation_id = excluded.generation_id,
         request_seq = excluded.request_seq,
         updated_at = excluded.updated_at
       WHERE excluded.request_seq > hls_active.request_seq`,
    ).run(
      generation.assetId,
      generation.fileVersion,
      generation.profileHash,
      generation.id,
      generation.requestSeq,
      input.fence.now,
    )

    if (active && active.generationId !== generation.id) {
      db.query<null, Params>(
        `UPDATE hls_generations SET superseded_at = ?, eligible_for_gc_at = ?
         WHERE id = ? AND state = 'ready'`,
      ).run(input.fence.now, input.fence.now + input.graceMs, active.generationId)
    }

    const current = getHlsActive(
      db,
      generation.assetId,
      generation.fileVersion,
      generation.profileHash,
    )
    return { published: true, activated: current?.generationId === generation.id }
  }).immediate()
}

/** Access is a hint for GC, so one write per two minutes per generation is enough. */
export function touchHlsGenerationAccess(
  db: Db,
  id: string,
  now: number,
  minAgeMs = HLS_ACCESS_TOUCH_MS,
): void {
  db.query<null, Params>(
    `UPDATE hls_generations SET last_access_at = ?
     WHERE id = ? AND state = 'ready'
       AND (last_access_at IS NULL OR last_access_at <= ?)`,
  ).run(now, id, now - minAgeMs)
}

/**
 * A `ready` generation that no `hls_active` row points at can never be served
 * again, so idleness alone makes it a candidate. `eligible_for_gc_at` still
 * holds a superseded generation back for its grace period, but a row that lost
 * its active pointer without that stamp (a crash, or the version trigger) is
 * reclaimed once its last touch is older than the idle window.
 */
export function listHlsGcCandidates(
  db: Db,
  now: number,
  minIdleMs: number,
  limit = 5,
): HlsGenerationRecord[] {
  return db
    .query<HlsGenerationRecord, Params>(
      `SELECT ${GENERATION_SELECT} FROM hls_generations g
       WHERE g.state = 'ready'
         AND (g.eligible_for_gc_at IS NULL OR g.eligible_for_gc_at <= ?)
         AND COALESCE(g.last_access_at, g.published_at, g.updated_at) <= ?
         AND NOT EXISTS (SELECT 1 FROM hls_active a WHERE a.generation_id = g.id)
       ORDER BY COALESCE(g.eligible_for_gc_at, g.published_at, g.updated_at) ASC LIMIT ?`,
    )
    .all(now, now - minIdleMs, limit)
}

export function listHlsDeleting(db: Db, limit = 5): HlsGenerationRecord[] {
  return db
    .query<HlsGenerationRecord, Params>(
      `SELECT ${GENERATION_SELECT} FROM hls_generations
       WHERE state = 'deleting' ORDER BY updated_at ASC LIMIT ?`,
    )
    .all(limit)
}

/** Marks a victim before touching the disk so a crash leaves a repairable row. */
export function markHlsGenerationDeleting(db: Db, id: string): boolean {
  const result = db
    .query<null, Params>(
      `UPDATE hls_generations SET state = 'deleting'
       WHERE id = ? AND state = 'ready'
         AND NOT EXISTS (SELECT 1 FROM hls_active a WHERE a.generation_id = hls_generations.id)`,
    )
    .run(id)
  return result.changes === 1
}

export function markHlsGenerationRemoved(db: Db, id: string): boolean {
  const result = db
    .query<null, Params>(
      `UPDATE hls_generations SET state = 'removed', storage_rel = NULL, playlist_rel = NULL
       WHERE id = ? AND state = 'deleting'`,
    )
    .run(id)
  return result.changes === 1
}

/**
 * A generation whose job reached a terminal state without publishing can never
 * finish on its own. Reconciliation marks it failed instead of leaving the API
 * reporting `preparing` forever.
 */
export function failOrphanedHlsGenerations(db: Db): number {
  return db.transaction(() => {
    const rows = db
      .query<{ id: string; jobId: number | null }, Params>(
        `SELECT id, job_id AS jobId FROM hls_generations
         WHERE state IN ('queued','running','retry_wait')`,
      )
      .all()
    let failed = 0
    for (const row of rows) {
      const job = row.jobId === null ? null : getJob(db, row.jobId)
      if (job && (job.state === 'queued' || job.state === 'running' || job.state === 'paused')) {
        continue
      }
      const result = db
        .query<null, Params>(
          `UPDATE hls_generations SET state = 'failed', stage = NULL,
             error_code = 'orphaned', error_message = 'the HLS job is no longer queued or running'
           WHERE id = ? AND state IN ('queued','running','retry_wait')`,
        )
        .run(row.id)
      failed += result.changes
    }
    return failed
  }).immediate()
}
