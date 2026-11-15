import type { SQLQueryBindings } from 'bun:sqlite'
import type { EmbeddingJobState, EmbeddingStage } from '@mediavault/shared'
import { newId } from '@mediavault/shared'
import { assetsByIds } from './assets'
import type { Db } from './db'
import type {
  AssetRecord,
  EmbeddingFingerprint,
  EmbeddingJobRecord,
  VideoEmbeddingRecord,
} from './types'

type Params = SQLQueryBindings[]

const ACTIVE_STATES = "('queued','embedding','writing')"

const ACTIVE = new Set<EmbeddingJobState>(['queued', 'embedding', 'writing'])

const JOB_COLUMNS = `
  id, asset_id AS assetId, file_version AS fileVersion,
  source_transcript_id AS sourceTranscriptId, state, stage, progress, attempts,
  max_attempts AS maxAttempts, lease_owner AS leaseOwner,
  lease_expires_at AS leaseExpiresAt, run_after AS runAfter, model_id AS modelId,
  model_revision AS modelRevision, model_sha256 AS modelSha256,
  pipeline_version AS pipelineVersion, dimensions, error_message AS errorMessage,
  started_at AS startedAt, created_at AS createdAt, updated_at AS updatedAt
`

const EMBEDDING_COLUMNS = `
  id, job_id AS jobId, asset_id AS assetId, file_version AS fileVersion,
  source_transcript_id AS sourceTranscriptId, kind, chunk_index AS chunkIndex,
  start_ms AS startMs, end_ms AS endMs, text, model_sha256 AS modelSha256,
  pipeline_version AS pipelineVersion, dimensions, created_at AS createdAt
`

/**
 * The newest transcript for whichever asset and version the row belongs to.
 * A vector built from an older transcript describes audio that is no longer
 * there, so the readers below only accept a row this subquery points at.
 */
function currentTranscript(alias: string): string {
  return `(
    SELECT t.id FROM transcripts t
    WHERE t.asset_id = ${alias}.asset_id
      AND t.file_version = ${alias}.file_version
    ORDER BY t.created_at DESC LIMIT 1
  )`
}

export interface CreateEmbeddingJobInput {
  id: string
  assetId: string
  fileVersion: number
  sourceTranscriptId: string | null
  modelId: string
  modelRevision: string
  modelSha256: string
  pipelineVersion: string
  dimensions: number
  maxAttempts?: number
}

export interface EmbeddingVectorInput {
  kind: 'title' | 'chunk'
  chunkIndex: number
  startMs: number | null
  endMs: number | null
  text: string
  vector: Float32Array
}

export interface CompleteEmbeddingJobInput {
  jobId: string
  owner: string
  vectors: EmbeddingVectorInput[]
}

/**
 * A row is stale once the model, the pipeline, or the source transcript it was
 * built from changed. Comparing inside the upsert keeps this one statement, so
 * two enqueues for the same asset cannot interleave a read with a write.
 */
const STALE_ROW = `(
  embedding_jobs.model_sha256 <> excluded.model_sha256
  OR embedding_jobs.pipeline_version <> excluded.pipeline_version
  OR embedding_jobs.dimensions <> excluded.dimensions
  OR embedding_jobs.source_transcript_id IS NOT excluded.source_transcript_id
)`

function resetWhenStale(column: string, value: string): string {
  return `${column} = CASE WHEN ${STALE_ROW} THEN ${value} ELSE embedding_jobs.${column} END`
}

const UPSERT_SETS = [
  resetWhenStale('source_transcript_id', 'excluded.source_transcript_id'),
  resetWhenStale('state', "'queued'"),
  resetWhenStale('stage', "'queued'"),
  resetWhenStale('progress', '0'),
  resetWhenStale('attempts', '0'),
  resetWhenStale('lease_owner', 'NULL'),
  resetWhenStale('lease_expires_at', 'NULL'),
  resetWhenStale('run_after', '0'),
  resetWhenStale('model_id', 'excluded.model_id'),
  resetWhenStale('model_revision', 'excluded.model_revision'),
  resetWhenStale('model_sha256', 'excluded.model_sha256'),
  resetWhenStale('pipeline_version', 'excluded.pipeline_version'),
  resetWhenStale('dimensions', 'excluded.dimensions'),
  resetWhenStale('error_message', 'NULL'),
  resetWhenStale('started_at', 'NULL'),
  resetWhenStale('updated_at', 'excluded.updated_at'),
].join(',\n         ')

/**
 * Queues one embedding pass for a file version. An active row is reused as it
 * stands when nothing it depends on changed, and rebuilt from scratch when it did.
 *
 * A finished row is reused too: re-running the backfill, or asking for the same
 * video twice, must not queue a second pass over work that is already current.
 * Without this, every run adds a row per video and spends the card again.
 */
export function createEmbeddingJob(
  db: Db,
  input: CreateEmbeddingJobInput,
  now: number,
): EmbeddingJobRecord {
  const newest = db
    .query<EmbeddingJobRecord, Params>(
      `SELECT ${JOB_COLUMNS} FROM embedding_jobs
       WHERE asset_id = ? AND file_version = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(input.assetId, input.fileVersion)

  if (newest && isCurrent(newest, input)) return newest

  if (newest && !ACTIVE.has(newest.state)) {
    // Reset the finished row in place so the table keeps one row per file version.
    db.query<null, Params>(
      `UPDATE embedding_jobs SET
         source_transcript_id = ?, state = 'queued', stage = 'queued', progress = 0,
         attempts = 0, lease_owner = NULL, lease_expires_at = NULL, run_after = 0,
         model_id = ?, model_revision = ?, model_sha256 = ?, pipeline_version = ?,
         dimensions = ?, error_message = NULL, started_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.sourceTranscriptId,
      input.modelId,
      input.modelRevision,
      input.modelSha256,
      input.pipelineVersion,
      input.dimensions,
      now,
      newest.id,
    )
    return getEmbeddingJob(db, newest.id)!
  }

  return db
    .query<EmbeddingJobRecord, Params>(
      `INSERT INTO embedding_jobs (
         id, asset_id, file_version, source_transcript_id, state, stage, progress,
         max_attempts, model_id, model_revision, model_sha256, pipeline_version,
         dimensions, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'queued', 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (asset_id, file_version) WHERE state IN ${ACTIVE_STATES}
       DO UPDATE SET ${UPSERT_SETS}
       RETURNING ${JOB_COLUMNS}`,
    )
    .get(
      input.id,
      input.assetId,
      input.fileVersion,
      input.sourceTranscriptId,
      input.maxAttempts ?? 3,
      input.modelId,
      input.modelRevision,
      input.modelSha256,
      input.pipelineVersion,
      input.dimensions,
      now,
      now,
    )!
}

/** True when a finished row already holds the vectors this input would produce. */
function isCurrent(row: EmbeddingJobRecord, input: CreateEmbeddingJobInput): boolean {
  return (
    row.state === 'completed' &&
    row.modelSha256 === input.modelSha256 &&
    row.pipelineVersion === input.pipelineVersion &&
    row.dimensions === input.dimensions &&
    row.sourceTranscriptId === input.sourceTranscriptId
  )
}

export function getEmbeddingJob(db: Db, id: string): EmbeddingJobRecord | null {
  return (
    db
      .query<EmbeddingJobRecord, Params>(`SELECT ${JOB_COLUMNS} FROM embedding_jobs WHERE id = ?`)
      .get(id) ?? null
  )
}

/**
 * One embedding runs at a time because it owns the whole GPU. The claim refuses
 * while another embedding holds a live lease, so a second worker cannot start a
 * second llama-server.
 */
export function claimEmbeddingJob(
  db: Db,
  owner: string,
  leaseMs: number,
  now: number,
): EmbeddingJobRecord | null {
  return (
    db
      .query<EmbeddingJobRecord, Params>(
        `UPDATE embedding_jobs SET
           state = 'embedding', stage = 'starting', progress = 0,
           attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?,
           started_at = ?, updated_at = ?
         WHERE id = (
           SELECT id FROM embedding_jobs
           WHERE state = 'queued' AND run_after <= ?
             AND NOT EXISTS (
               SELECT 1 FROM embedding_jobs running
               WHERE running.state IN ('embedding','writing')
                 AND running.lease_expires_at IS NOT NULL
                 AND running.lease_expires_at >= ?
             )
           ORDER BY created_at ASC, id ASC
           LIMIT 1
         )
         RETURNING ${JOB_COLUMNS}`,
      )
      .get(owner, now + leaseMs, now, now, now, now) ?? null
  )
}

export function heartbeatEmbeddingJob(
  db: Db,
  id: string,
  owner: string,
  leaseMs: number,
  now: number,
): boolean {
  return (
    db
      .query<null, Params>(
        `UPDATE embedding_jobs SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND lease_owner = ? AND state IN ${ACTIVE_STATES}
           AND lease_expires_at >= ?`,
      )
      .run(now + leaseMs, now, id, owner, now).changes > 0
  )
}

/**
 * Returns false when the lease was lost, which tells the worker to stop.
 */
export function updateEmbeddingProgress(
  db: Db,
  id: string,
  owner: string,
  update: { state: EmbeddingJobState; stage: EmbeddingStage; progress: number; leaseMs: number },
  now: number,
): boolean {
  return (
    db
      .query<null, Params>(
        `UPDATE embedding_jobs SET state = ?, stage = ?, progress = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND lease_owner = ? AND state IN ${ACTIVE_STATES}`,
      )
      .run(
        update.state,
        update.stage,
        Math.max(0, Math.min(100, Math.round(update.progress))),
        now + update.leaseMs,
        now,
        id,
        owner,
      ).changes > 0
  )
}

function toFloats(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.slice().buffer)
}

/**
 * The row's blob must be a unit vector of exactly the job's dimension. Both are
 * checked here as well as at the route, because a stored vector that is the
 * wrong length turns every later cosine into a silent NaN.
 */
function assertUsableVector(vector: Float32Array, dimensions: number): void {
  if (vector.length !== dimensions) {
    throw new Error(`embedding has ${vector.length} dimensions, expected ${dimensions}`)
  }
  let sum = 0
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error('embedding holds a non-finite value')
    sum += value * value
  }
  const norm = Math.sqrt(sum)
  if (Math.abs(norm - 1) > 1e-3) {
    throw new Error(`embedding norm is ${norm.toFixed(4)}, expected 1`)
  }
}

/**
 * Replaces every stored vector for the asset's file version. The asset can be
 * deleted while the job runs, and the lease can move to another worker, so both
 * are re-checked here rather than trusted from the route.
 */
export function completeEmbeddingJob(
  db: Db,
  input: CompleteEmbeddingJobInput,
  now: number,
): boolean {
  const job = getEmbeddingJob(db, input.jobId)
  if (!job || job.leaseOwner !== input.owner) return false

  const asset = db
    .query<{ id: string }, Params>('SELECT id FROM assets WHERE id = ? AND deleted_at IS NULL')
    .get(job.assetId)
  if (!asset) return false

  for (const item of input.vectors) assertUsableVector(item.vector, job.dimensions)

  db.transaction(() => {
    db.query<null, Params>('DELETE FROM video_embeddings WHERE asset_id = ? AND file_version = ?').run(
      job.assetId,
      job.fileVersion,
    )

    const insert = db.query<null, Params>(
      `INSERT INTO video_embeddings (
         id, job_id, asset_id, file_version, source_transcript_id, kind, chunk_index,
         start_ms, end_ms, text, model_sha256, pipeline_version, dimensions, vector, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const item of input.vectors) {
      insert.run(
        newId(16),
        job.id,
        job.assetId,
        job.fileVersion,
        job.sourceTranscriptId,
        item.kind,
        item.chunkIndex,
        item.startMs,
        item.endMs,
        item.text,
        job.modelSha256,
        job.pipelineVersion,
        job.dimensions,
        Buffer.from(item.vector.buffer, item.vector.byteOffset, item.vector.byteLength),
        now,
      )
    }

    db.query<null, Params>(
      `UPDATE embedding_jobs SET
         state = 'completed', stage = 'completed', progress = 100,
         lease_owner = NULL, lease_expires_at = NULL, error_message = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(now, job.id)
  })()

  return true
}

export function failEmbeddingJob(
  db: Db,
  id: string,
  message: string,
  now: number,
): EmbeddingJobState | null {
  const job = getEmbeddingJob(db, id)
  if (!job) return null

  if (job.attempts >= job.maxAttempts) {
    db.query<null, Params>(
      `UPDATE embedding_jobs SET
         state = 'failed', stage = 'queued', lease_owner = NULL, lease_expires_at = NULL,
         error_message = ?, updated_at = ?
       WHERE id = ?`,
    ).run(message.slice(0, 2000), now, id)
    return 'failed'
  }

  const backoff = Math.min(60_000, 5_000 * job.attempts * job.attempts)
  db.query<null, Params>(
    `UPDATE embedding_jobs SET
       state = 'queued', stage = 'queued', progress = 0, lease_owner = NULL, lease_expires_at = NULL,
       error_message = ?, run_after = ?, updated_at = ?
     WHERE id = ?`,
  ).run(message.slice(0, 2000), now + backoff, now, id)
  return 'queued'
}

export function cancelEmbeddingJob(db: Db, id: string, now: number): void {
  db.query<null, Params>(
    `UPDATE embedding_jobs SET
       state = 'canceled', stage = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND state IN ${ACTIVE_STATES}`,
  ).run(now, id)
}

/**
 * A worker that dies mid-job leaves its lease behind. Expired leases go back to
 * the queue with the attempt already counted, so a crash loop still ends at
 * max_attempts instead of spinning forever.
 */
export function recoverExpiredEmbeddingJobs(db: Db, now: number): number {
  return db
    .query<null, Params>(
      `UPDATE embedding_jobs SET
         state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
         stage = 'queued', progress = 0, lease_owner = NULL, lease_expires_at = NULL,
         error_message = 'The worker stopped before finishing.', updated_at = ?
       WHERE state IN ('embedding','writing')
         AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
    )
    .run(now, now).changes
}

/**
 * The vectors a reader may rank with: the current model and pipeline, built
 * from the asset's current transcript.
 */
export function getCurrentEmbedding(
  db: Db,
  assetId: string,
  fileVersion: number,
  fingerprint: EmbeddingFingerprint,
): VideoEmbeddingRecord[] {
  const rows = db
    .query<Omit<VideoEmbeddingRecord, 'vector'> & { vector: Uint8Array }, Params>(
      `SELECT ${EMBEDDING_COLUMNS}, vector FROM video_embeddings
       WHERE asset_id = ? AND file_version = ?
         AND model_sha256 = ? AND pipeline_version = ? AND dimensions = ?
         AND source_transcript_id IS ${currentTranscript('video_embeddings')}
       ORDER BY kind DESC, chunk_index ASC`,
    )
    .all(assetId, fileVersion, fingerprint.modelSha256, fingerprint.pipelineVersion, fingerprint.dimensions)
  return rows.map((row) => ({ ...row, vector: toFloats(row.vector) }))
}

/**
 * Ranks every other video by the closest pair of stored vectors. Brute force in
 * JS: a gallery holds thousands of chunks, and a scan costs less than the index
 * it would take to beat it.
 *
 * Vectors are stored at unit length, so the dot product is the cosine. A
 * re-upload of the source file scores 1 against itself and is dropped by name
 * and size.
 */
export function relatedByEmbedding(
  db: Db,
  userId: string,
  assetId: string,
  fileVersion: number,
  fingerprint: EmbeddingFingerprint,
  limit: number,
): AssetRecord[] {
  const source = db
    .query<{ filename: string; sizeBytes: number }, Params>(
      'SELECT filename, size_bytes AS sizeBytes FROM assets WHERE id = ? AND deleted_at IS NULL',
    )
    .get(assetId)
  if (!source) return []

  const mine = getCurrentEmbedding(db, assetId, fileVersion, fingerprint)
  if (mine.length === 0) return []

  const rows = db
    .query<{ assetId: string; filename: string; sizeBytes: number; vector: Uint8Array }, Params>(
      `SELECT e.asset_id AS assetId, a.filename, a.size_bytes AS sizeBytes, e.vector
       FROM video_embeddings e JOIN assets a ON a.id = e.asset_id
       WHERE e.asset_id <> ?
         AND a.deleted_at IS NULL
         AND e.file_version = a.file_version
         AND e.model_sha256 = ? AND e.pipeline_version = ? AND e.dimensions = ?
         AND e.source_transcript_id IS ${currentTranscript('e')}`,
    )
    .all(
      assetId,
      fingerprint.modelSha256,
      fingerprint.pipelineVersion,
      fingerprint.dimensions,
    )

  const best = new Map<string, number>()
  for (const row of rows) {
    if (row.filename === source.filename && row.sizeBytes === source.sizeBytes) continue
    const candidate = toFloats(row.vector)
    let top = best.get(row.assetId) ?? -Infinity
    for (const stored of mine) {
      const score = dot(stored.vector, candidate)
      if (score > top) top = score
    }
    best.set(row.assetId, top)
  }

  const ranked = [...best.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([id]) => id)
  if (ranked.length === 0) return []

  const byId = new Map(assetsByIds(db, userId, ranked).map((asset) => [asset.id, asset]))
  return ranked.flatMap((id) => {
    const asset = byId.get(id)
    return asset ? [asset] : []
  })
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let index = 0; index < a.length; index += 1) sum += a[index]! * b[index]!
  return sum
}
