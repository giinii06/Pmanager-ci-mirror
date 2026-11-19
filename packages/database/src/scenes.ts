import type { SQLQueryBindings } from 'bun:sqlite'
import type { SceneJobState, SceneStage } from '@mediavault/shared'
import { newId } from '@mediavault/shared'
import type { Db } from './db'
import { LEASE_IS_LIVE, RENEW_LEASE } from './leases'
import { asFloats } from './vectors'
import type {
  SceneJobRecord,
  SceneSearchHit,
  SceneVectorInput,
  VideoSceneRecord,
} from './types'

type Params = SQLQueryBindings[]

const ACTIVE_STATES = "('queued','extracting','embedding','writing')"

const ACTIVE = new Set<SceneJobState>(['queued', 'extracting', 'embedding', 'writing'])

const JOB_COLUMNS = `
  id, asset_id AS assetId, file_version AS fileVersion, state, stage, progress,
  attempts, max_attempts AS maxAttempts, lease_owner AS leaseOwner,
  lease_expires_at AS leaseExpiresAt, run_after AS runAfter, model_id AS modelId,
  model_revision AS modelRevision, model_sha256 AS modelSha256,
  pipeline_version AS pipelineVersion, dimensions, window_ms AS windowMs,
  overlap_ms AS overlapMs, analyzed_windows AS analyzedWindows,
  total_windows AS totalWindows, error_message AS errorMessage,
  started_at AS startedAt, created_at AS createdAt, updated_at AS updatedAt
`

const SCENE_COLUMNS = `
  id, job_id AS jobId, asset_id AS assetId, file_version AS fileVersion, seq,
  start_ms AS startMs, end_ms AS endMs, thumbnail_path AS thumbnailPath,
  model_sha256 AS modelSha256, pipeline_version AS pipelineVersion,
  created_at AS createdAt
`

export interface CreateSceneJobInput {
  id: string
  assetId: string
  fileVersion: number
  modelId: string
  modelRevision: string
  modelSha256: string
  pipelineVersion: string
  dimensions: number
  windowMs: number
  overlapMs: number
  maxAttempts?: number
  /** Restarts a completed run even when its model fingerprint still matches. */
  force?: boolean
}

export interface CompleteSceneJobInput {
  jobId: string
  owner: string
  scenes: SceneVectorInput[]
  /** Sampled windows against an uncapped plan, stored with the completed job. */
  coverage?: { analyzed: number; total: number }
}

const STALE_ROW = `(
  scene_jobs.model_sha256 <> excluded.model_sha256
  OR scene_jobs.pipeline_version <> excluded.pipeline_version
  OR scene_jobs.dimensions <> excluded.dimensions
  OR scene_jobs.window_ms <> excluded.window_ms
  OR scene_jobs.overlap_ms <> excluded.overlap_ms
)`

function resetWhenStale(column: string, value: string): string {
  return `${column} = CASE WHEN ${STALE_ROW} THEN ${value} ELSE scene_jobs.${column} END`
}

const UPSERT_SETS = [
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
  resetWhenStale('window_ms', 'excluded.window_ms'),
  resetWhenStale('overlap_ms', 'excluded.overlap_ms'),
  resetWhenStale('analyzed_windows', 'NULL'),
  resetWhenStale('total_windows', 'NULL'),
  resetWhenStale('error_message', 'NULL'),
  resetWhenStale('started_at', 'NULL'),
  resetWhenStale('updated_at', 'excluded.updated_at'),
].join(',\n         ')

/** True when a finished row already holds the windows this input would produce. */
function isCurrent(row: SceneJobRecord, input: CreateSceneJobInput): boolean {
  return (
    row.state === 'completed' &&
    row.modelSha256 === input.modelSha256 &&
    row.pipelineVersion === input.pipelineVersion &&
    row.dimensions === input.dimensions &&
    row.windowMs === input.windowMs &&
    row.overlapMs === input.overlapMs
  )
}

export function createSceneJob(db: Db, input: CreateSceneJobInput, now: number): SceneJobRecord {
  const newest = db
    .query<SceneJobRecord, Params>(
      `SELECT ${JOB_COLUMNS} FROM scene_jobs
       WHERE asset_id = ? AND file_version = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(input.assetId, input.fileVersion)

  if (newest && !input.force && isCurrent(newest, input)) return newest

  if (newest && !ACTIVE.has(newest.state)) {
    db.query<null, Params>(
      `UPDATE scene_jobs SET
         state = 'queued', stage = 'queued', progress = 0, attempts = 0,
         lease_owner = NULL, lease_expires_at = NULL, run_after = 0,
         model_id = ?, model_revision = ?, model_sha256 = ?, pipeline_version = ?,
         dimensions = ?, window_ms = ?, overlap_ms = ?,
         analyzed_windows = NULL, total_windows = NULL, error_message = NULL,
         started_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.modelId,
      input.modelRevision,
      input.modelSha256,
      input.pipelineVersion,
      input.dimensions,
      input.windowMs,
      input.overlapMs,
      now,
      newest.id,
    )
    return getSceneJob(db, newest.id)!
  }

  return db
    .query<SceneJobRecord, Params>(
      `INSERT INTO scene_jobs (
         id, asset_id, file_version, state, stage, progress, max_attempts, model_id,
         model_revision, model_sha256, pipeline_version, dimensions, window_ms,
         overlap_ms, created_at, updated_at
       ) VALUES (?, ?, ?, 'queued', 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (asset_id, file_version) WHERE state IN ${ACTIVE_STATES}
       DO UPDATE SET ${UPSERT_SETS}
       RETURNING ${JOB_COLUMNS}`,
    )
    .get(
      input.id,
      input.assetId,
      input.fileVersion,
      input.maxAttempts ?? 3,
      input.modelId,
      input.modelRevision,
      input.modelSha256,
      input.pipelineVersion,
      input.dimensions,
      input.windowMs,
      input.overlapMs,
      now,
      now,
    )!
}

export function getSceneJob(db: Db, id: string): SceneJobRecord | null {
  return (
    db.query<SceneJobRecord, Params>(`SELECT ${JOB_COLUMNS} FROM scene_jobs WHERE id = ?`).get(id) ??
    null
  )
}

/** A job that is queued or running for this file version, if any. */
export function activeSceneJob(db: Db, assetId: string, fileVersion: number): SceneJobRecord | null {
  return (
    db
      .query<SceneJobRecord, Params>(
        `SELECT ${JOB_COLUMNS} FROM scene_jobs
         WHERE asset_id = ? AND file_version = ? AND state IN ${ACTIVE_STATES}
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(assetId, fileVersion) ?? null
  )
}

/** One scene pass at a time, for the same reason the embedding lane allows one. */
export function claimSceneJob(db: Db, owner: string, leaseMs: number, now: number): SceneJobRecord | null {
  return (
    db
      .query<SceneJobRecord, Params>(
        `UPDATE scene_jobs SET
           state = 'extracting', stage = 'extracting', progress = 0,
           attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?,
           started_at = ?, updated_at = ?
         WHERE id = (
           SELECT id FROM scene_jobs
           WHERE state = 'queued' AND run_after <= ?
             AND NOT EXISTS (
               SELECT 1 FROM scene_jobs running
               WHERE running.state IN ('extracting','embedding','writing')
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

export function heartbeatSceneJob(db: Db, id: string, owner: string, now: number): boolean {
  return (
    db
      .query<null, Params>(
        `UPDATE scene_jobs SET ${RENEW_LEASE}
         WHERE id = ? AND lease_owner = ? AND state IN ${ACTIVE_STATES}
           AND ${LEASE_IS_LIVE}`,
      )
      .run(now, now, id, owner, now).changes > 0
  )
}

export function updateSceneProgress(
  db: Db,
  id: string,
  owner: string,
  update: { state: SceneJobState; stage: SceneStage; progress: number },
  now: number,
): boolean {
  return (
    db
      .query<null, Params>(
        `UPDATE scene_jobs SET state = ?, stage = ?, progress = ?, ${RENEW_LEASE}
         WHERE id = ? AND lease_owner = ? AND state IN ${ACTIVE_STATES}
           AND ${LEASE_IS_LIVE}`,
      )
      .run(
        update.state,
        update.stage,
        Math.max(0, Math.min(100, Math.round(update.progress))),
        now,
        now,
        id,
        owner,
        now,
      ).changes > 0
  )
}

function assertUsableVector(vector: Float32Array, dimensions: number): void {
  if (vector.length !== dimensions) {
    throw new Error(`scene vector has ${vector.length} dimensions, expected ${dimensions}`)
  }
  let sum = 0
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error('scene vector holds a non-finite value')
    sum += value * value
  }
  const norm = Math.sqrt(sum)
  if (Math.abs(norm - 1) > 1e-3) {
    throw new Error(`scene vector norm is ${norm.toFixed(4)}, expected 1`)
  }
}

/**
 * Replaces every window for the asset's file version. The asset can be deleted
 * while the job runs, and the lease can move, so both are re-checked here.
 */
export function completeSceneJob(db: Db, input: CompleteSceneJobInput, now: number): boolean {
  const job = getSceneJob(db, input.jobId)
  if (!job || job.leaseOwner !== input.owner) return false

  const asset = db
    .query<{ id: string }, Params>(
      'SELECT id FROM assets WHERE id = ? AND deleted_at IS NULL AND file_version = ?',
    )
    .get(job.assetId, job.fileVersion)
  if (!asset) return false

  for (const scene of input.scenes) {
    assertUsableVector(scene.visual, job.dimensions)
    assertUsableVector(scene.audio, job.dimensions)
    assertUsableVector(scene.av, job.dimensions)
  }

  db.transaction(() => {
    db.query<null, Params>('DELETE FROM video_scenes WHERE asset_id = ? AND file_version = ?').run(
      job.assetId,
      job.fileVersion,
    )

    const insertScene = db.query<null, Params>(
      `INSERT INTO video_scenes (
         id, job_id, asset_id, file_version, seq, start_ms, end_ms, thumbnail_path,
         model_sha256, pipeline_version, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertVector = db.query<null, Params>(
      `INSERT INTO scene_embeddings (scene_id, modality, dimensions, vector)
       VALUES (?, ?, ?, ?)`,
    )
    for (const scene of input.scenes) {
      const sceneId = newId(16)
      insertScene.run(
        sceneId,
        job.id,
        job.assetId,
        job.fileVersion,
        scene.seq,
        scene.startMs,
        scene.endMs,
        scene.thumbnailPath,
        job.modelSha256,
        job.pipelineVersion,
        now,
      )
      insertVector.run(
        sceneId,
        'visual',
        job.dimensions,
        Buffer.from(scene.visual.buffer, scene.visual.byteOffset, scene.visual.byteLength),
      )
      insertVector.run(
        sceneId,
        'audio',
        job.dimensions,
        Buffer.from(scene.audio.buffer, scene.audio.byteOffset, scene.audio.byteLength),
      )
      insertVector.run(
        sceneId,
        'av',
        job.dimensions,
        Buffer.from(scene.av.buffer, scene.av.byteOffset, scene.av.byteLength),
      )
    }

    db.query<null, Params>(
      `UPDATE scene_jobs SET
         state = 'completed', stage = 'completed', progress = 100,
         analyzed_windows = ?, total_windows = ?,
         lease_owner = NULL, lease_expires_at = NULL, error_message = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.coverage?.analyzed ?? null,
      input.coverage?.total ?? null,
      now,
      job.id,
    )
    db.query<null, Params>("DELETE FROM stage_checkpoints WHERE job_id = ?").run(job.id)
  })()

  return true
}

export function failSceneJob(db: Db, id: string, message: string, now: number): SceneJobState | null {
  const job = getSceneJob(db, id)
  if (!job) return null

  if (job.attempts >= job.maxAttempts) {
    db.query<null, Params>(
      `UPDATE scene_jobs SET
         state = 'failed', stage = 'queued', lease_owner = NULL, lease_expires_at = NULL,
         error_message = ?, updated_at = ?
       WHERE id = ?`,
    ).run(message.slice(0, 2000), now, id)
    return 'failed'
  }

  const backoff = Math.min(60_000, 5_000 * job.attempts * job.attempts)
  db.query<null, Params>(
    `UPDATE scene_jobs SET
       state = 'queued', stage = 'queued', progress = 0, lease_owner = NULL,
       lease_expires_at = NULL, error_message = ?, run_after = ?, updated_at = ?
     WHERE id = ?`,
  ).run(message.slice(0, 2000), now + backoff, now, id)
  return 'queued'
}

export function cancelSceneJob(db: Db, id: string, now: number): void {
  db.query<null, Params>(
    `UPDATE scene_jobs SET
       state = 'canceled', stage = 'queued', lease_owner = NULL, lease_expires_at = NULL,
       updated_at = ?
     WHERE id = ? AND state IN ${ACTIVE_STATES}`,
  ).run(now, id)
}

export function recoverExpiredSceneJobs(db: Db, now: number): number {
  return db
    .query<null, Params>(
      `UPDATE scene_jobs SET
         state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
         stage = 'queued', progress = 0, lease_owner = NULL, lease_expires_at = NULL,
         error_message = 'The worker stopped before finishing.', updated_at = ?
       WHERE state IN ('extracting','embedding','writing')
         AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
    )
    .run(now, now).changes
}

/** The windows a reader may rank with: current model, current pipeline, current file. */
export function getCurrentScenes(
  db: Db,
  assetId: string,
  fileVersion: number,
  fingerprint: { modelSha256: string; pipelineVersion: string },
): VideoSceneRecord[] {
  return db
    .query<VideoSceneRecord, Params>(
      `SELECT ${SCENE_COLUMNS} FROM video_scenes
       WHERE asset_id = ? AND file_version = ?
         AND model_sha256 = ? AND pipeline_version = ?
       ORDER BY seq ASC`,
    )
    .all(assetId, fileVersion, fingerprint.modelSha256, fingerprint.pipelineVersion)
}

export function getScene(db: Db, sceneId: string): VideoSceneRecord | null {
  return (
    db
      .query<VideoSceneRecord, Params>(`SELECT ${SCENE_COLUMNS} FROM video_scenes WHERE id = ?`)
      .get(sceneId) ?? null
  )
}

export interface SceneQueryVectors {
  visual: Float32Array
  audio: Float32Array
  av: Float32Array
}

/**
 * Ranks every window against the three query vectors. Each modality is compared
 * only with its own column: the text towers produce different spaces, so a
 * visual query must not be scored against an audio window.
 *
 * Brute force in JS, like the related-video scan. A library of a few thousand
 * windows costs less to scan than an index would cost to keep.
 */
export function searchScenes(
  db: Db,
  query: SceneQueryVectors,
  fingerprint: { modelSha256: string; pipelineVersion: string; dimensions: number },
  limit: number,
): SceneSearchHit[] {
  const startedAt = performance.now()
  const rows = db
    .query<
      {
        sceneId: string
        assetId: string
        seq: number
        startMs: number
        endMs: number
        thumbnailPath: string | null
        modality: 'visual' | 'audio' | 'av'
        vector: Uint8Array
      },
      Params
    >(
      `SELECT s.id AS sceneId, s.asset_id AS assetId, s.seq, s.start_ms AS startMs,
              s.end_ms AS endMs, s.thumbnail_path AS thumbnailPath, e.modality, e.vector
       FROM scene_embeddings e
       JOIN video_scenes s ON s.id = e.scene_id
       JOIN assets a ON a.id = s.asset_id
       WHERE a.deleted_at IS NULL
         AND s.file_version = a.file_version
         AND s.model_sha256 = ? AND s.pipeline_version = ?
         AND e.dimensions = ?`,
    )
    .iterate(fingerprint.modelSha256, fingerprint.pipelineVersion, fingerprint.dimensions)

  const queries: Record<'visual' | 'audio' | 'av', Float32Array> = {
    visual: query.visual,
    audio: query.audio,
    av: query.av,
  }

  const best = new Map<string, SceneSearchHit>()
  let scanned = 0
  for (const row of rows) {
    scanned += 1
    const candidate = asFloats(row.vector, fingerprint.dimensions)
    const score = dot(queries[row.modality], candidate)
    const previous = best.get(row.sceneId)
    if (!previous || score > previous.score) {
      best.set(row.sceneId, {
        sceneId: row.sceneId,
        assetId: row.assetId,
        seq: row.seq,
        startMs: row.startMs,
        endMs: row.endMs,
        thumbnailPath: row.thumbnailPath,
        score,
        modality: row.modality,
      })
    }
  }
  const materializedAt = performance.now()

  const ranked = [...best.values()].sort(
    (a, b) => b.score - a.score || a.sceneId.localeCompare(b.sceneId),
  )
  const rankedAt = performance.now()
  console.info(
    JSON.stringify({
      event: 'search.scenes',
      rows: scanned,
      materializeMs: Math.round((materializedAt - startedAt) * 10) / 10,
      rankMs: Math.round((rankedAt - materializedAt) * 10) / 10,
      totalMs: Math.round((rankedAt - startedAt) * 10) / 10,
    }),
  )
  return ranked.slice(0, limit)
}

/** The sampled-window coverage recorded when a job completed, if any. */
export function getSceneCoverage(
  db: Db,
  assetId: string,
  fileVersion: number,
  options: { modelSha256: string; pipelineVersion: string },
): { analyzed: number; total: number } | null {
  const row = db
    .query<{ analyzed: number | null; total: number | null }, Params>(
      `SELECT analyzed_windows AS analyzed, total_windows AS total FROM scene_jobs
       WHERE asset_id = ? AND file_version = ? AND model_sha256 = ? AND pipeline_version = ?
         AND state = 'completed'
         AND analyzed_windows IS NOT NULL AND total_windows IS NOT NULL
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(assetId, fileVersion, options.modelSha256, options.pipelineVersion)
  if (!row || row.analyzed === null || row.total === null) return null
  return { analyzed: row.analyzed, total: row.total }
}

export function countScenesForAsset(db: Db, assetId: string): number {
  return (
    db
      .query<{ count: number }, Params>('SELECT COUNT(*) AS count FROM video_scenes WHERE asset_id = ?')
      .get(assetId)?.count ?? 0
  )
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let index = 0; index < a.length; index += 1) sum += a[index]! * b[index]!
  return sum
}
