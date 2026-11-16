import type { SQLQueryBindings } from 'bun:sqlite'
import type { FaceJobState, FaceStage, PersonState } from '@mediavault/shared'
import { newId } from '@mediavault/shared'
import type { Db } from './db'
import { LEASE_IS_LIVE, RENEW_LEASE } from './leases'
import type {
  FaceDetectionRecord,
  FaceJobRecord,
  FaceVectorInput,
  PersonAssetRecord,
  PersonRecord,
} from './types'

type Params = SQLQueryBindings[]

const ACTIVE_STATES = "('queued','detecting','writing')"

const JOB_COLUMNS = `
  id, asset_id AS assetId, file_version AS fileVersion, state, stage, progress,
  attempts, max_attempts AS maxAttempts, lease_owner AS leaseOwner,
  lease_expires_at AS leaseExpiresAt, run_after AS runAfter, model_id AS modelId,
  model_revision AS modelRevision, model_sha256 AS modelSha256,
  pipeline_version AS pipelineVersion, dimensions, sample_ms AS sampleMs,
  error_message AS errorMessage, started_at AS startedAt,
  created_at AS createdAt, updated_at AS updatedAt
`

const PERSON_COLUMNS = `
  id, name, state, cover_detection_id AS coverDetectionId, face_count AS faceCount,
  dimensions, model_sha256 AS modelSha256, created_at AS createdAt, updated_at AS updatedAt
`

export interface CreateFaceJobInput {
  id: string
  assetId: string
  fileVersion: number
  modelId: string
  modelRevision: string
  modelSha256: string
  pipelineVersion: string
  dimensions: number
  sampleMs: number
  maxAttempts?: number
}

export interface CompleteFaceJobInput {
  jobId: string
  owner: string
  faces: FaceVectorInput[]
  matchThreshold: number
  candidateThreshold: number
}

const STALE_ROW = `(
  face_jobs.model_sha256 <> excluded.model_sha256
  OR face_jobs.pipeline_version <> excluded.pipeline_version
  OR face_jobs.dimensions <> excluded.dimensions
  OR face_jobs.sample_ms <> excluded.sample_ms
)`

function resetWhenStale(column: string, value: string): string {
  return `${column} = CASE WHEN ${STALE_ROW} THEN ${value} ELSE face_jobs.${column} END`
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
  resetWhenStale('sample_ms', 'excluded.sample_ms'),
  resetWhenStale('error_message', 'NULL'),
  resetWhenStale('started_at', 'NULL'),
  resetWhenStale('updated_at', 'excluded.updated_at'),
].join(',\n         ')

function isCurrent(row: FaceJobRecord, input: CreateFaceJobInput): boolean {
  return (
    row.state === 'completed' &&
    row.modelSha256 === input.modelSha256 &&
    row.pipelineVersion === input.pipelineVersion &&
    row.dimensions === input.dimensions &&
    row.sampleMs === input.sampleMs
  )
}

export function createFaceJob(db: Db, input: CreateFaceJobInput, now: number): FaceJobRecord {
  const newest = db
    .query<FaceJobRecord, Params>(
      `SELECT ${JOB_COLUMNS} FROM face_jobs
       WHERE asset_id = ? AND file_version = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(input.assetId, input.fileVersion)

  if (newest && isCurrent(newest, input)) return newest

  if (newest && !['queued', 'detecting', 'writing'].includes(newest.state)) {
    db.query<null, Params>(
      `UPDATE face_jobs SET
         state = 'queued', stage = 'queued', progress = 0, attempts = 0,
         lease_owner = NULL, lease_expires_at = NULL, run_after = 0,
         model_id = ?, model_revision = ?, model_sha256 = ?, pipeline_version = ?,
         dimensions = ?, sample_ms = ?, error_message = NULL, started_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.modelId,
      input.modelRevision,
      input.modelSha256,
      input.pipelineVersion,
      input.dimensions,
      input.sampleMs,
      now,
      newest.id,
    )
    return getFaceJob(db, newest.id)!
  }

  return db
    .query<FaceJobRecord, Params>(
      `INSERT INTO face_jobs (
         id, asset_id, file_version, state, stage, progress, max_attempts, model_id,
         model_revision, model_sha256, pipeline_version, dimensions, sample_ms,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'queued', 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.sampleMs,
      now,
      now,
    )!
}

export function getFaceJob(db: Db, id: string): FaceJobRecord | null {
  return (
    db.query<FaceJobRecord, Params>(`SELECT ${JOB_COLUMNS} FROM face_jobs WHERE id = ?`).get(id) ??
    null
  )
}

/** A face job that is queued or running for this file version, if any. */
export function activeFaceJob(db: Db, assetId: string, fileVersion: number): FaceJobRecord | null {
  return (
    db
      .query<FaceJobRecord, Params>(
        `SELECT ${JOB_COLUMNS} FROM face_jobs
         WHERE asset_id = ? AND file_version = ? AND state IN ${ACTIVE_STATES}
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(assetId, fileVersion) ?? null
  )
}

/**
 * Faces run on the CPU, so several can run at once. The only serialisation is
 * per asset, which the unique index already gives.
 */
export function claimFaceJob(db: Db, owner: string, leaseMs: number, now: number): FaceJobRecord | null {
  return (
    db
      .query<FaceJobRecord, Params>(
        `UPDATE face_jobs SET
           state = 'detecting', stage = 'sampling', progress = 0,
           attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?,
           started_at = ?, updated_at = ?
         WHERE id = (
           SELECT id FROM face_jobs
           WHERE state = 'queued' AND run_after <= ?
           ORDER BY created_at ASC, id ASC
           LIMIT 1
         )
         RETURNING ${JOB_COLUMNS}`,
      )
      .get(owner, now + leaseMs, now, now, now) ?? null
  )
}

export function heartbeatFaceJob(db: Db, id: string, owner: string, now: number): boolean {
  return (
    db
      .query<null, Params>(
        `UPDATE face_jobs SET ${RENEW_LEASE}
         WHERE id = ? AND lease_owner = ? AND state IN ${ACTIVE_STATES}
           AND ${LEASE_IS_LIVE}`,
      )
      .run(now, now, id, owner, now).changes > 0
  )
}

export function updateFaceProgress(
  db: Db,
  id: string,
  owner: string,
  update: { state: FaceJobState; stage: FaceStage; progress: number },
  now: number,
): boolean {
  return (
    db
      .query<null, Params>(
        `UPDATE face_jobs SET state = ?, stage = ?, progress = ?, ${RENEW_LEASE}
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

function toFloats(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.slice().buffer)
}

function normalise(vector: Float32Array): Float32Array {
  let sum = 0
  for (const value of vector) sum += value * value
  const norm = Math.sqrt(sum)
  if (!Number.isFinite(norm) || norm === 0) return vector
  const out = new Float32Array(vector.length)
  for (let index = 0; index < vector.length; index += 1) out[index] = vector[index]! / norm
  return out
}

function assertUsableVector(vector: Float32Array, dimensions: number): void {
  if (vector.length !== dimensions) {
    throw new Error(`face vector has ${vector.length} dimensions, expected ${dimensions}`)
  }
  let sum = 0
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error('face vector holds a non-finite value')
    sum += value * value
  }
  const norm = Math.sqrt(sum)
  if (Math.abs(norm - 1) > 1e-3) {
    throw new Error(`face vector norm is ${norm.toFixed(4)}, expected 1`)
  }
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let index = 0; index < a.length; index += 1) sum += a[index]! * b[index]!
  return sum
}

/** Recomputes the mean direction of a person's faces and their cover. */
function refreshPerson(db: Db, personId: string, now: number): void {
  const rows = db
    .query<{ detectionId: string; score: number; vector: Uint8Array }, Params>(
      `SELECT pf.detection_id AS detectionId, d.score, e.vector
       FROM person_faces pf
       JOIN face_embeddings e ON e.detection_id = pf.detection_id
       JOIN face_detections d ON d.id = pf.detection_id
       WHERE pf.person_id = ?`,
    )
    .all(personId)

  if (rows.length === 0) {
    db.query<null, Params>('DELETE FROM people WHERE id = ?').run(personId)
    return
  }

  const dimensions = toFloats(rows[0]!.vector).length
  const sum = new Float32Array(dimensions)
  let cover = rows[0]!
  for (const row of rows) {
    const vector = toFloats(row.vector)
    for (let index = 0; index < dimensions; index += 1) {
      sum[index] = sum[index]! + vector[index]!
    }
    if (row.score > cover.score) cover = row
  }
  const centroid = normalise(sum)

  db.query<null, Params>(
    `UPDATE people SET face_count = ?, cover_detection_id = ?, centroid = ?, dimensions = ?,
       updated_at = ? WHERE id = ?`,
  ).run(
    rows.length,
    cover.detectionId,
    Buffer.from(centroid.buffer, centroid.byteOffset, centroid.byteLength),
    dimensions,
    now,
    personId,
  )

  db.query<null, Params>('DELETE FROM person_assets WHERE person_id = ?').run(personId)
  db.query<null, Params>(
    `INSERT INTO person_assets (person_id, asset_id, face_count, best_detection_id)
     SELECT pf.person_id, d.asset_id, COUNT(*),
            (SELECT d2.id FROM person_faces pf2
             JOIN face_detections d2 ON d2.id = pf2.detection_id
             WHERE pf2.person_id = pf.person_id AND d2.asset_id = d.asset_id
             ORDER BY d2.score DESC LIMIT 1)
     FROM person_faces pf
     JOIN face_detections d ON d.id = pf.detection_id
     WHERE pf.person_id = ?
     GROUP BY d.asset_id`,
  ).run(personId)
}

interface Candidate {
  id: string
  state: PersonState
  centroid: Float32Array
}

/**
 * Puts every new face on a person. An approved person wins over a candidate at
 * the same similarity, because the user already said that person exists. A face
 * that matches nobody seeds a new candidate, which the review queue shows.
 */
function assignFaces(
  db: Db,
  faces: Array<{ detectionId: string; vector: Float32Array }>,
  matchThreshold: number,
  candidateThreshold: number,
  now: number,
): void {
  const people = db
    .query<{ id: string; state: PersonState; centroid: Uint8Array }, Params>(
      `SELECT id, state, centroid FROM people
       WHERE state IN ('approved','candidate') AND centroid IS NOT NULL`,
    )
    .all()
    .map<Candidate>((row) => ({ id: row.id, state: row.state, centroid: toFloats(row.centroid) }))

  const touched = new Set<string>()
  const insertLink = db.query<null, Params>(
    `INSERT INTO person_faces (person_id, detection_id, similarity, source, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )

  for (const face of faces) {
    let best: { person: Candidate; score: number } | null = null
    for (const person of people) {
      if (person.centroid.length !== face.vector.length) continue
      const score = dot(person.centroid, face.vector)
      const floor = person.state === 'approved' ? matchThreshold : candidateThreshold
      if (score < floor) continue
      if (
        !best ||
        score > best.score ||
        (score === best.score && person.state === 'approved' && best.person.state !== 'approved')
      ) {
        best = { person, score }
      }
    }

    if (best) {
      insertLink.run(best.person.id, face.detectionId, best.score, 'assigned', now)
      touched.add(best.person.id)
      continue
    }

    const personId = newId(16)
    const name = `인물 ${people.length + 1}`
    db.query<null, Params>(
      `INSERT INTO people (id, name, state, face_count, centroid, dimensions, created_at, updated_at)
       VALUES (?, ?, 'candidate', 0, ?, ?, ?, ?)`,
    ).run(
      personId,
      name,
      Buffer.from(face.vector.buffer, face.vector.byteOffset, face.vector.byteLength),
      face.vector.length,
      now,
      now,
    )
    insertLink.run(personId, face.detectionId, 1, 'seed', now)
    const candidate: Candidate = { id: personId, state: 'candidate', centroid: face.vector }
    people.push(candidate)
    touched.add(personId)
  }

  for (const personId of touched) refreshPerson(db, personId, now)
}

export function completeFaceJob(db: Db, input: CompleteFaceJobInput, now: number): boolean {
  const job = getFaceJob(db, input.jobId)
  if (!job || job.leaseOwner !== input.owner) return false

  // A completion for a version the asset no longer has is dropped, so a
  // replaced file cannot keep detections from its old copy.
  const asset = db
    .query<{ id: string }, Params>(
      'SELECT id FROM assets WHERE id = ? AND deleted_at IS NULL AND file_version = ?',
    )
    .get(job.assetId, job.fileVersion)
  if (!asset) return false

  for (const face of input.faces) assertUsableVector(face.vector, job.dimensions)

  db.transaction(() => {
    // A re-run replaces the detections of this file version. The person links
    // cascade with the detections, so the affected people are refreshed below.
    const affected = db
      .query<{ personId: string }, Params>(
        `SELECT DISTINCT pf.person_id AS personId
         FROM person_faces pf JOIN face_detections d ON d.id = pf.detection_id
         WHERE d.asset_id = ? AND d.file_version = ?`,
      )
      .all(job.assetId, job.fileVersion)
      .map((row) => row.personId)

    db.query<null, Params>('DELETE FROM face_detections WHERE asset_id = ? AND file_version = ?').run(
      job.assetId,
      job.fileVersion,
    )

    const insertDetection = db.query<null, Params>(
      `INSERT INTO face_detections (
         id, job_id, asset_id, file_version, frame_ms, x, y, width, height, score,
         thumbnail_path, model_sha256, pipeline_version, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertVector = db.query<null, Params>(
      'INSERT INTO face_embeddings (detection_id, dimensions, vector) VALUES (?, ?, ?)',
    )
    const faces: Array<{ detectionId: string; vector: Float32Array }> = []
    for (const face of input.faces) {
      const detectionId = newId(16)
      insertDetection.run(
        detectionId,
        job.id,
        job.assetId,
        job.fileVersion,
        face.frameMs,
        face.x,
        face.y,
        face.width,
        face.height,
        face.score,
        face.thumbnailPath,
        job.modelSha256,
        job.pipelineVersion,
        now,
      )
      insertVector.run(
        detectionId,
        job.dimensions,
        Buffer.from(face.vector.buffer, face.vector.byteOffset, face.vector.byteLength),
      )
      faces.push({ detectionId, vector: face.vector })
    }

    assignFaces(db, faces, input.matchThreshold, input.candidateThreshold, now)

    for (const personId of affected) {
      const still = db
        .query<{ count: number }, Params>(
          'SELECT COUNT(*) AS count FROM person_faces WHERE person_id = ?',
        )
        .get(personId)
      if (still && still.count > 0) refreshPerson(db, personId, now)
      else db.query<null, Params>('DELETE FROM people WHERE id = ?').run(personId)
    }

    db.query<null, Params>(
      `UPDATE face_jobs SET
         state = 'completed', stage = 'completed', progress = 100,
         lease_owner = NULL, lease_expires_at = NULL, error_message = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(now, job.id)
  })()

  return true
}

export function failFaceJob(db: Db, id: string, message: string, now: number): FaceJobState | null {
  const job = getFaceJob(db, id)
  if (!job) return null

  if (job.attempts >= job.maxAttempts) {
    db.query<null, Params>(
      `UPDATE face_jobs SET
         state = 'failed', stage = 'queued', lease_owner = NULL, lease_expires_at = NULL,
         error_message = ?, updated_at = ?
       WHERE id = ?`,
    ).run(message.slice(0, 2000), now, id)
    return 'failed'
  }

  const backoff = Math.min(60_000, 5_000 * job.attempts * job.attempts)
  db.query<null, Params>(
    `UPDATE face_jobs SET
       state = 'queued', stage = 'queued', progress = 0, lease_owner = NULL,
       lease_expires_at = NULL, error_message = ?, run_after = ?, updated_at = ?
     WHERE id = ?`,
  ).run(message.slice(0, 2000), now + backoff, now, id)
  return 'queued'
}

export function recoverExpiredFaceJobs(db: Db, now: number): number {
  return db
    .query<null, Params>(
      `UPDATE face_jobs SET
         state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
         stage = 'queued', progress = 0, lease_owner = NULL, lease_expires_at = NULL,
         error_message = 'The worker stopped before finishing.', updated_at = ?
       WHERE state IN ('detecting','writing')
         AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
    )
    .run(now, now).changes
}

export function getPerson(db: Db, id: string): PersonRecord | null {
  const row = db
    .query<Omit<PersonRecord, 'centroid'> & { centroid: Uint8Array | null }, Params>(
      `SELECT ${PERSON_COLUMNS}, centroid FROM people WHERE id = ?`,
    )
    .get(id)
  if (!row) return null
  return { ...row, centroid: row.centroid ? toFloats(row.centroid) : null }
}

export function listPeople(
  db: Db,
  state: PersonState | 'all',
  limit: number,
): Array<PersonRecord & { assetCount: number }> {
  const where = state === 'all' ? '' : 'WHERE p.state = ?'
  const params: Params = state === 'all' ? [] : [state]
  const rows = db
    .query<Omit<PersonRecord, 'centroid'> & { assetCount: number }, Params>(
      `SELECT ${PERSON_COLUMNS.split(',').map((column) => `p.${column.trim()}`).join(', ')},
              (SELECT COUNT(*) FROM person_assets pa WHERE pa.person_id = p.id) AS assetCount
       FROM people p ${where}
       ORDER BY p.face_count DESC, p.created_at ASC
       LIMIT ?`,
    )
    .all(...params, limit)
  return rows.map((row) => ({ ...row, centroid: null }))
}

export function personFaces(
  db: Db,
  personId: string,
  limit: number,
): Array<{ detectionId: string; assetId: string; filename: string; frameMs: number }> {
  return db
    .query<{ detectionId: string; assetId: string; filename: string; frameMs: number }, Params>(
      `SELECT d.id AS detectionId, d.asset_id AS assetId, a.filename, d.frame_ms AS frameMs
       FROM person_faces pf
       JOIN face_detections d ON d.id = pf.detection_id
       JOIN assets a ON a.id = d.asset_id
       WHERE pf.person_id = ?
       ORDER BY d.score DESC, d.frame_ms ASC
       LIMIT ?`,
    )
    .all(personId, limit)
}

export function personAssets(db: Db, personId: string): PersonAssetRecord[] {
  return db
    .query<PersonAssetRecord, Params>(
      `SELECT pa.person_id AS personId, pa.asset_id AS assetId, pa.face_count AS faceCount,
              pa.best_detection_id AS bestDetectionId, a.filename, a.duration_ms AS durationMs
       FROM person_assets pa JOIN assets a ON a.id = pa.asset_id
       WHERE pa.person_id = ?
       ORDER BY pa.face_count DESC, pa.asset_id ASC`,
    )
    .all(personId)
}

export function getDetection(
  db: Db,
  detectionId: string,
): { id: string; assetId: string; frameMs: number; thumbnailPath: string | null } | null {
  return (
    db
      .query<
        { id: string; assetId: string; frameMs: number; thumbnailPath: string | null },
        Params
      >(
        `SELECT id, asset_id AS assetId, frame_ms AS frameMs,
                thumbnail_path AS thumbnailPath
         FROM face_detections WHERE id = ?`,
      )
      .get(detectionId) ?? null
  )
}

function recordAction(
  db: Db,
  personId: string | null,
  action: 'approve' | 'exclude' | 'merge' | 'split' | 'rename' | 'rescan',
  payload: unknown,
  userId: string | null,
  now: number,
): void {
  db.query<null, Params>(
    `INSERT INTO person_review_actions (id, person_id, action, payload, user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(newId(16), personId, action, payload === null ? null : JSON.stringify(payload), userId, now)
}

export function setPersonState(
  db: Db,
  id: string,
  state: PersonState,
  userId: string | null,
  now: number,
): PersonRecord | null {
  const person = getPerson(db, id)
  if (!person) return null
  db.query<null, Params>('UPDATE people SET state = ?, updated_at = ? WHERE id = ?').run(
    state,
    now,
    id,
  )
  recordAction(db, id, state === 'approved' ? 'approve' : 'exclude', null, userId, now)
  return getPerson(db, id)
}

export function renamePerson(
  db: Db,
  id: string,
  name: string,
  userId: string | null,
  now: number,
): PersonRecord | null {
  const person = getPerson(db, id)
  if (!person) return null
  db.query<null, Params>('UPDATE people SET name = ?, updated_at = ? WHERE id = ?').run(
    name,
    now,
    id,
  )
  recordAction(db, id, 'rename', { from: person.name, to: name }, userId, now)
  return getPerson(db, id)
}

/** Moves every face from `sourceId` into `targetId` and deletes the source. */
export function mergePeople(
  db: Db,
  sourceId: string,
  targetId: string,
  userId: string | null,
  now: number,
): PersonRecord | null {
  if (sourceId === targetId) return getPerson(db, targetId)
  const target = getPerson(db, targetId)
  const source = getPerson(db, sourceId)
  if (!target || !source) return null

  db.transaction(() => {
    db.query<null, Params>(
      `UPDATE person_faces SET person_id = ?, source = 'manual' WHERE person_id = ?`,
    ).run(targetId, sourceId)
    db.query<null, Params>('DELETE FROM people WHERE id = ?').run(sourceId)
    refreshPerson(db, targetId, now)
  })()
  recordAction(db, targetId, 'merge', { sourceId, sourceName: source.name }, userId, now)
  return getPerson(db, targetId)
}

/** Moves the named detections out of `personId` into a new person. */
export function splitPerson(
  db: Db,
  personId: string,
  detectionIds: string[],
  name: string,
  userId: string | null,
  now: number,
): PersonRecord | null {
  const person = getPerson(db, personId)
  if (!person || detectionIds.length === 0) return null
  if (detectionIds.length >= person.faceCount) return null

  const created = newId(16)
  db.transaction(() => {
    db.query<null, Params>(
      `INSERT INTO people (id, name, state, face_count, created_at, updated_at)
       VALUES (?, ?, 'candidate', 0, ?, ?)`,
    ).run(created, name, now, now)
    const move = db.query<null, Params>(
      `UPDATE person_faces SET person_id = ?, source = 'manual'
       WHERE person_id = ? AND detection_id = ?`,
    )
    for (const detectionId of detectionIds) move.run(created, personId, detectionId)
    refreshPerson(db, personId, now)
    refreshPerson(db, created, now)
  })()
  recordAction(db, personId, 'split', { createdId: created, detectionIds }, userId, now)
  return getPerson(db, created)
}

/** Drops every candidate and its faces. Approved people keep theirs. */
export function resetCandidates(db: Db, userId: string | null, now: number): number {
  const candidates = db
    .query<{ id: string }, Params>("SELECT id FROM people WHERE state = 'candidate'")
    .all()
  db.transaction(() => {
    for (const candidate of candidates) {
      db.query<null, Params>('DELETE FROM people WHERE id = ?').run(candidate.id)
    }
  })()
  recordAction(db, null, 'rescan', { dropped: candidates.length }, userId, now)
  return candidates.length
}

/**
 * Drops every candidate and regroups the faces that are left unassigned.
 * Approved people keep their faces, so a rescan never loses work the user did.
 */
export function reclusterUnassigned(
  db: Db,
  matchThreshold: number,
  candidateThreshold: number,
  userId: string | null,
  now: number,
): number {
  const dropped = resetCandidates(db, userId, now)
  const orphaned = db
    .query<{ detectionId: string; vector: Uint8Array }, Params>(
      `SELECT d.id AS detectionId, e.vector
       FROM face_detections d
       JOIN face_embeddings e ON e.detection_id = d.id
       WHERE NOT EXISTS (SELECT 1 FROM person_faces pf WHERE pf.detection_id = d.id)`,
    )
    .all()
    .map((row) => ({ detectionId: row.detectionId, vector: toFloats(row.vector) }))

  db.transaction(() => {
    assignFaces(db, orphaned, matchThreshold, candidateThreshold, now)
  })()
  return dropped
}

export function countPeople(db: Db, state: PersonState | 'all'): number {
  return (
    db
      .query<{ count: number }, Params>(
        state === 'all'
          ? 'SELECT COUNT(*) AS count FROM people'
          : 'SELECT COUNT(*) AS count FROM people WHERE state = ?',
      )
      .get(...(state === 'all' ? [] : [state]))?.count ?? 0
  )
}

export function faceDetectionAt(
  db: Db,
  assetId: string,
  detectionId: string,
): FaceDetectionRecord | null {
  return (
    db
      .query<FaceDetectionRecord, Params>(
        `SELECT id, job_id AS jobId, asset_id AS assetId, file_version AS fileVersion,
                frame_ms AS frameMs, x, y, width, height, score,
                thumbnail_path AS thumbnailPath,
                model_sha256 AS modelSha256, pipeline_version AS pipelineVersion,
                created_at AS createdAt
         FROM face_detections WHERE asset_id = ? AND id = ?`,
      )
      .get(assetId, detectionId) ?? null
  )
}
