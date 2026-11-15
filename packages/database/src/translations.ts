import type { SQLQueryBindings } from 'bun:sqlite'
import type { TranslationJobState, TranslationStage } from '@mediavault/shared'
import type { Db } from './db'
import type {
  TranslationJobRecord,
  TranslationRecord,
  TranslationSegmentRecord,
  TranslationWithSegments,
} from './types'

type Params = SQLQueryBindings[]

const ACTIVE_STATES = "('queued','translating','writing')"

const JOB_COLUMNS = `
  id, source_transcript_id AS sourceTranscriptId, asset_id AS assetId,
  file_version AS fileVersion, source_language AS sourceLanguage,
  target_language AS targetLanguage, state, stage, progress, attempts,
  max_attempts AS maxAttempts, lease_owner AS leaseOwner,
  lease_expires_at AS leaseExpiresAt, run_after AS runAfter, model_id AS modelId,
  model_revision AS modelRevision, model_sha256 AS modelSha256,
  prompt_version AS promptVersion, pipeline_version AS pipelineVersion,
  error_message AS errorMessage, created_at AS createdAt, updated_at AS updatedAt
`

const TRANSLATION_COLUMNS = `
  id, job_id AS jobId, source_transcript_id AS sourceTranscriptId, asset_id AS assetId,
  file_version AS fileVersion, source_language AS sourceLanguage,
  target_language AS targetLanguage, plain_text AS plainText, result_dir AS resultDir,
  model_id AS modelId, model_revision AS modelRevision, model_sha256 AS modelSha256,
  prompt_version AS promptVersion, pipeline_version AS pipelineVersion,
  created_at AS createdAt
`

export interface CreateTranslationJobInput {
  id: string
  sourceTranscriptId: string
  assetId: string
  fileVersion: number
  sourceLanguage: string
  targetLanguage: string
  modelId: string
  modelRevision: string
  modelSha256: string
  promptVersion: string
  pipelineVersion: string
  maxAttempts?: number
}

export interface CompleteTranslationJobInput {
  jobId: string
  owner: string
  translationId: string
  resultDir: string
  plainText: string
  segments: TranslationSegmentRecord[]
}

export interface TranslationFingerprint {
  modelSha256: string
  promptVersion: string
  pipelineVersion: string
}

export function createTranslationJob(
  db: Db,
  input: CreateTranslationJobInput,
  now: number,
): TranslationJobRecord {
  const existing = activeTranslationJob(db, input.sourceTranscriptId, input.targetLanguage)
  if (existing) {
    const sameFingerprint =
      existing.modelSha256 === input.modelSha256 &&
      existing.promptVersion === input.promptVersion &&
      existing.pipelineVersion === input.pipelineVersion
    // A queued job from an older model would finish as a result the reader
    // rejects, so it is replaced instead of joined.
    if (sameFingerprint) return existing
    cancelTranslationJob(db, existing.id, now)
  }

  return db
    .query<TranslationJobRecord, Params>(
      `INSERT INTO translation_jobs (
         id, source_transcript_id, asset_id, file_version, source_language, target_language,
         state, stage, progress, max_attempts, model_id, model_revision, model_sha256,
         prompt_version, pipeline_version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_transcript_id, target_language) WHERE state IN ${ACTIVE_STATES}
       DO UPDATE SET updated_at = translation_jobs.updated_at
       RETURNING ${JOB_COLUMNS}`,
    )
    .get(
      input.id,
      input.sourceTranscriptId,
      input.assetId,
      input.fileVersion,
      input.sourceLanguage,
      input.targetLanguage,
      input.maxAttempts ?? 3,
      input.modelId,
      input.modelRevision,
      input.modelSha256,
      input.promptVersion,
      input.pipelineVersion,
      now,
      now,
    )!
}

export function getTranslationJob(db: Db, id: string): TranslationJobRecord | null {
  return (
    db
      .query<TranslationJobRecord, Params>(`SELECT ${JOB_COLUMNS} FROM translation_jobs WHERE id = ?`)
      .get(id) ?? null
  )
}

export function activeTranslationJob(
  db: Db,
  sourceTranscriptId: string,
  targetLanguage: string,
): TranslationJobRecord | null {
  return (
    db
      .query<TranslationJobRecord, Params>(
        `SELECT ${JOB_COLUMNS} FROM translation_jobs
         WHERE source_transcript_id = ? AND target_language = ? AND state IN ${ACTIVE_STATES}
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sourceTranscriptId, targetLanguage) ?? null
  )
}

export function latestTranslationJob(
  db: Db,
  assetId: string,
  fileVersion: number,
  targetLanguage: string,
): TranslationJobRecord | null {
  return (
    db
      .query<TranslationJobRecord, Params>(
        `SELECT ${JOB_COLUMNS} FROM translation_jobs
         WHERE asset_id = ? AND file_version = ? AND target_language = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(assetId, fileVersion, targetLanguage) ?? null
  )
}

/**
 * One translation runs at a time because it owns the whole GPU. The claim
 * refuses while another translation holds a live lease, so a second worker
 * cannot start a second llama-server.
 */
export function claimTranslationJob(
  db: Db,
  owner: string,
  leaseMs: number,
  now: number,
): TranslationJobRecord | null {
  return (
    db
      .query<TranslationJobRecord, Params>(
        `UPDATE translation_jobs SET
           state = 'translating', stage = 'starting', progress = 0,
           attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = (
           SELECT id FROM translation_jobs
           WHERE state = 'queued' AND run_after <= ?
             AND NOT EXISTS (
               SELECT 1 FROM translation_jobs running
               WHERE running.state IN ('translating','writing')
                 AND running.lease_expires_at IS NOT NULL
                 AND running.lease_expires_at >= ?
             )
           ORDER BY created_at ASC, id ASC
           LIMIT 1
         )
         RETURNING ${JOB_COLUMNS}`,
      )
      .get(owner, now + leaseMs, now, now, now) ?? null
  )
}

export function heartbeatTranslationJob(
  db: Db,
  id: string,
  owner: string,
  leaseMs: number,
  now: number,
): boolean {
  return (
    db
      .query<null, Params>(
        `UPDATE translation_jobs SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND lease_owner = ? AND state IN ${ACTIVE_STATES}`,
      )
      .run(now + leaseMs, now, id, owner).changes > 0
  )
}

/**
 * Returns false when the lease was lost, which tells the worker to stop.
 */
export function updateTranslationProgress(
  db: Db,
  id: string,
  owner: string,
  update: { state: TranslationJobState; stage: TranslationStage; progress: number; leaseMs: number },
  now: number,
): boolean {
  return (
    db
      .query<null, Params>(
        `UPDATE translation_jobs SET state = ?, stage = ?, progress = ?, lease_expires_at = ?, updated_at = ?
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

/**
 * The source transcript can be replaced while a translation runs. Writing the
 * result against a transcript that no longer exists would attach subtitles to
 * the wrong audio, so the transaction refuses and the job stays claimable.
 */
export function completeTranslationJob(
  db: Db,
  input: CompleteTranslationJobInput,
  now: number,
): TranslationRecord | null {
  const job = getTranslationJob(db, input.jobId)
  if (!job || job.leaseOwner !== input.owner) return null

  let stored: TranslationRecord | null = null
  db.transaction(() => {
    const source = db
      .query<{ id: string }, Params>('SELECT id FROM transcripts WHERE id = ?')
      .get(job.sourceTranscriptId)
    if (!source) return

    db.query<null, Params>(
      `DELETE FROM translations
       WHERE source_transcript_id = ? AND target_language = ?
         AND model_sha256 = ? AND prompt_version = ? AND pipeline_version = ?`,
    ).run(
      job.sourceTranscriptId,
      job.targetLanguage,
      job.modelSha256,
      job.promptVersion,
      job.pipelineVersion,
    )

    stored = db
      .query<TranslationRecord, Params>(
        `INSERT INTO translations (
           id, job_id, source_transcript_id, asset_id, file_version, source_language,
           target_language, plain_text, result_dir, model_id, model_revision, model_sha256,
           prompt_version, pipeline_version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING ${TRANSLATION_COLUMNS}`,
      )
      .get(
        input.translationId,
        job.id,
        job.sourceTranscriptId,
        job.assetId,
        job.fileVersion,
        job.sourceLanguage,
        job.targetLanguage,
        input.plainText,
        input.resultDir,
        job.modelId,
        job.modelRevision,
        job.modelSha256,
        job.promptVersion,
        job.pipelineVersion,
        now,
      )!

    const insertSegment = db.query<null, Params>(
      `INSERT INTO translation_segments (translation_id, source_seq, start_ms, end_ms, text)
       VALUES (?, ?, ?, ?, ?)`,
    )
    for (const segment of input.segments) {
      insertSegment.run(
        input.translationId,
        segment.seq,
        Math.max(0, Math.round(segment.startMs)),
        Math.max(0, Math.round(segment.endMs)),
        segment.text,
      )
    }

    db.query<null, Params>(
      `UPDATE translation_jobs SET
         state = 'completed', stage = 'completed', progress = 100,
         lease_owner = NULL, lease_expires_at = NULL, error_message = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(now, job.id)
  })()

  return stored
}

export function failTranslationJob(
  db: Db,
  id: string,
  message: string,
  now: number,
): TranslationJobState | null {
  const job = getTranslationJob(db, id)
  if (!job) return null

  if (job.attempts >= job.maxAttempts) {
    db.query<null, Params>(
      `UPDATE translation_jobs SET
         state = 'failed', stage = 'queued', lease_owner = NULL, lease_expires_at = NULL,
         error_message = ?, updated_at = ?
       WHERE id = ?`,
    ).run(message.slice(0, 2000), now, id)
    return 'failed'
  }

  const backoff = Math.min(60_000, 5_000 * job.attempts * job.attempts)
  db.query<null, Params>(
    `UPDATE translation_jobs SET
       state = 'queued', stage = 'queued', progress = 0, lease_owner = NULL, lease_expires_at = NULL,
       error_message = ?, run_after = ?, updated_at = ?
     WHERE id = ?`,
  ).run(message.slice(0, 2000), now + backoff, now, id)
  return 'queued'
}

export function cancelTranslationJob(db: Db, id: string, now: number): void {
  db.query<null, Params>(
    `UPDATE translation_jobs SET
       state = 'canceled', stage = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND state IN ${ACTIVE_STATES}`,
  ).run(now, id)
}

/**
 * A worker that dies mid-job leaves its lease behind. Expired leases go back to
 * the queue with the attempt already counted, so a crash loop still ends at
 * max_attempts instead of spinning forever.
 */
export function recoverExpiredTranslationJobs(db: Db, now: number): number {
  return db
    .query<null, Params>(
      `UPDATE translation_jobs SET
         state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
         stage = 'queued', progress = 0, lease_owner = NULL, lease_expires_at = NULL,
         error_message = 'The worker stopped before finishing.', updated_at = ?
       WHERE state IN ('translating','writing')
         AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
    )
    .run(now, now).changes
}

export function getTranslation(
  db: Db,
  assetId: string,
  fileVersion: number,
  targetLanguage: string,
): TranslationWithSegments | null {
  const translation =
    db
      .query<TranslationRecord, Params>(
        `SELECT ${TRANSLATION_COLUMNS} FROM translations
         WHERE asset_id = ? AND file_version = ? AND target_language = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(assetId, fileVersion, targetLanguage) ?? null
  if (!translation) return null
  return { translation, segments: segmentsFor(db, translation.id) }
}

export function getTranslationByJob(db: Db, jobId: string): TranslationWithSegments | null {
  const translation =
    db
      .query<TranslationRecord, Params>(`SELECT ${TRANSLATION_COLUMNS} FROM translations WHERE job_id = ?`)
      .get(jobId) ?? null
  if (!translation) return null
  return { translation, segments: segmentsFor(db, translation.id) }
}

/**
 * A stored result only counts when it was built from the current transcript
 * with the current model and prompt. Anything else is a stale cache entry.
 */
export function isCurrentTranslation(
  translation: TranslationRecord,
  sourceTranscriptId: string,
  fingerprint: TranslationFingerprint,
): boolean {
  return (
    translation.sourceTranscriptId === sourceTranscriptId &&
    translation.modelSha256 === fingerprint.modelSha256 &&
    translation.promptVersion === fingerprint.promptVersion &&
    translation.pipelineVersion === fingerprint.pipelineVersion
  )
}

function segmentsFor(db: Db, translationId: string): TranslationSegmentRecord[] {
  return db
    .query<TranslationSegmentRecord, Params>(
      `SELECT source_seq AS seq, start_ms AS startMs, end_ms AS endMs, text
       FROM translation_segments WHERE translation_id = ? ORDER BY source_seq ASC`,
    )
    .all(translationId)
}

export function searchTranslation(
  db: Db,
  translationId: string,
  query: string,
  limit = 50,
): TranslationSegmentRecord[] {
  const escaped = query.replace(/[\\%_]/g, (match) => `\\${match}`)
  return db
    .query<TranslationSegmentRecord, Params>(
      `SELECT source_seq AS seq, start_ms AS startMs, end_ms AS endMs, text
       FROM translation_segments
       WHERE translation_id = ? AND text LIKE ? ESCAPE '\\'
       ORDER BY source_seq ASC LIMIT ?`,
    )
    .all(translationId, `%${escaped}%`, limit)
}
