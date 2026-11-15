import type { SQLQueryBindings } from 'bun:sqlite'
import type { AsrJobState, AsrStage } from '@mediavault/shared'
import type { Db } from './db'
import type {
  AsrJobRecord,
  TranscriptRecord,
  TranscriptSegmentRecord,
  TranscriptWithSegments,
} from './types'

type Params = SQLQueryBindings[]

const ACTIVE_STATES = "('queued','transcribing','aligning','writing')"

const JOB_COLUMNS = `
  id, asset_id AS assetId, file_version AS fileVersion, state, stage, progress,
  attempts, max_attempts AS maxAttempts, lease_owner AS leaseOwner,
  lease_expires_at AS leaseExpiresAt, run_after AS runAfter,
  model_revision AS modelRevision, aligner_revision AS alignerRevision,
  pipeline_version AS pipelineVersion, error_message AS errorMessage,
  created_at AS createdAt, updated_at AS updatedAt
`

const TRANSCRIPT_COLUMNS = `
  id, job_id AS jobId, asset_id AS assetId, file_version AS fileVersion, language,
  result_dir AS resultDir, plain_text AS plainText, model_revision AS modelRevision,
  aligner_revision AS alignerRevision, pipeline_version AS pipelineVersion,
  created_at AS createdAt
`

export interface CreateAsrJobInput {
  id: string
  assetId: string
  fileVersion: number
  modelRevision: string
  alignerRevision: string
  pipelineVersion: string
  maxAttempts?: number
}

export interface CompleteAsrJobInput {
  jobId: string
  transcriptId: string
  resultDir: string
  plainText: string
  language: string
  segments: TranscriptSegmentRecord[]
}

export function createAsrJob(db: Db, input: CreateAsrJobInput, now: number): AsrJobRecord {
  const existing = activeAsrJob(db, input.assetId, input.fileVersion)
  if (existing) return existing

  return db
    .query<AsrJobRecord, Params>(
      `INSERT INTO asr_jobs (
         id, asset_id, file_version, state, stage, progress, max_attempts,
         model_revision, aligner_revision, pipeline_version, created_at, updated_at
       ) VALUES (?, ?, ?, 'queued', 'queued', 0, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (asset_id, file_version) WHERE state IN ${ACTIVE_STATES}
       DO UPDATE SET updated_at = asr_jobs.updated_at
       RETURNING ${JOB_COLUMNS}`,
    )
    .get(
      input.id,
      input.assetId,
      input.fileVersion,
      input.maxAttempts ?? 3,
      input.modelRevision,
      input.alignerRevision,
      input.pipelineVersion,
      now,
      now,
    )!
}

export function getAsrJob(db: Db, id: string): AsrJobRecord | null {
  return (
    db.query<AsrJobRecord, Params>(`SELECT ${JOB_COLUMNS} FROM asr_jobs WHERE id = ?`).get(id) ?? null
  )
}

export function activeAsrJob(db: Db, assetId: string, fileVersion: number): AsrJobRecord | null {
  return (
    db
      .query<AsrJobRecord, Params>(
        `SELECT ${JOB_COLUMNS} FROM asr_jobs
         WHERE asset_id = ? AND file_version = ? AND state IN ${ACTIVE_STATES}
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(assetId, fileVersion) ?? null
  )
}

export function latestAsrJob(db: Db, assetId: string, fileVersion: number): AsrJobRecord | null {
  return (
    db
      .query<AsrJobRecord, Params>(
        `SELECT ${JOB_COLUMNS} FROM asr_jobs
         WHERE asset_id = ? AND file_version = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(assetId, fileVersion) ?? null
  )
}

export function claimAsrJob(
  db: Db,
  owner: string,
  leaseMs: number,
  now: number,
): AsrJobRecord | null {
  return (
    db
      .query<AsrJobRecord, Params>(
        `UPDATE asr_jobs SET
           state = 'transcribing', stage = 'extracting', progress = 0,
           attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = (
           SELECT id FROM asr_jobs
           WHERE state = 'queued' AND run_after <= ?
             AND NOT EXISTS (
               SELECT 1 FROM asr_jobs running
               WHERE running.state IN ('transcribing','aligning','writing')
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

export function heartbeatAsrJob(
  db: Db,
  id: string,
  owner: string,
  leaseMs: number,
  now: number,
): boolean {
  return (
    db
      .query<null, Params>(
        `UPDATE asr_jobs SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND lease_owner = ? AND state IN ${ACTIVE_STATES}`,
      )
      .run(now + leaseMs, now, id, owner).changes > 0
  )
}

/**
 * Returns false when the lease was lost, which tells the worker to stop.
 */
export function updateAsrProgress(
  db: Db,
  id: string,
  owner: string,
  update: { state: AsrJobState; stage: AsrStage; progress: number; leaseMs: number },
  now: number,
): boolean {
  return (
    db
      .query<null, Params>(
        `UPDATE asr_jobs SET state = ?, stage = ?, progress = ?, lease_expires_at = ?, updated_at = ?
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

export function completeAsrJob(
  db: Db,
  input: CompleteAsrJobInput,
  now: number,
): TranscriptRecord | null {
  const job = getAsrJob(db, input.jobId)
  if (!job) return null

  let transcript: TranscriptRecord | null = null
  db.transaction(() => {
    db.query<null, Params>(
      `DELETE FROM transcripts
       WHERE asset_id = ? AND file_version = ? AND model_revision = ?
         AND aligner_revision = ? AND pipeline_version = ?`,
    ).run(job.assetId, job.fileVersion, job.modelRevision, job.alignerRevision, job.pipelineVersion)

    transcript = db
      .query<TranscriptRecord, Params>(
        `INSERT INTO transcripts (
           id, job_id, asset_id, file_version, language, result_dir, plain_text,
           model_revision, aligner_revision, pipeline_version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING ${TRANSCRIPT_COLUMNS}`,
      )
      .get(
        input.transcriptId,
        job.id,
        job.assetId,
        job.fileVersion,
        input.language,
        input.resultDir,
        input.plainText,
        job.modelRevision,
        job.alignerRevision,
        job.pipelineVersion,
        now,
      )!

    const insertSegment = db.query<null, Params>(
      `INSERT INTO transcript_segments (transcript_id, seq, start_ms, end_ms, text)
       VALUES (?, ?, ?, ?, ?)`,
    )
    input.segments.forEach((segment, index) => {
      insertSegment.run(
        input.transcriptId,
        index,
        Math.max(0, Math.round(segment.startMs)),
        Math.max(0, Math.round(segment.endMs)),
        segment.text,
      )
    })

    db.query<null, Params>(
      `UPDATE asr_jobs SET
         state = 'completed', stage = 'completed', progress = 100,
         lease_owner = NULL, lease_expires_at = NULL, error_message = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(now, job.id)
  })()

  return transcript
}

export function failAsrJob(db: Db, id: string, message: string, now: number): AsrJobState | null {
  const job = getAsrJob(db, id)
  if (!job) return null

  if (job.attempts >= job.maxAttempts) {
    db.query<null, Params>(
      `UPDATE asr_jobs SET
         state = 'failed', stage = 'queued', lease_owner = NULL, lease_expires_at = NULL,
         error_message = ?, updated_at = ?
       WHERE id = ?`,
    ).run(message.slice(0, 2000), now, id)
    return 'failed'
  }

  const backoff = Math.min(60_000, 5_000 * job.attempts * job.attempts)
  db.query<null, Params>(
    `UPDATE asr_jobs SET
       state = 'queued', stage = 'queued', progress = 0, lease_owner = NULL, lease_expires_at = NULL,
       error_message = ?, run_after = ?, updated_at = ?
     WHERE id = ?`,
  ).run(message.slice(0, 2000), now + backoff, now, id)
  return 'queued'
}

export function cancelAsrJob(db: Db, id: string, now: number): void {
  db.query<null, Params>(
    `UPDATE asr_jobs SET
       state = 'canceled', stage = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND state IN ${ACTIVE_STATES}`,
  ).run(now, id)
}

/**
 * A worker that dies mid-job leaves its lease behind. Expired leases go back to
 * the queue with the attempt already counted, so a crash loop still ends at
 * max_attempts instead of spinning forever.
 */
export function recoverExpiredAsrJobs(db: Db, now: number): number {
  return db
    .query<null, Params>(
      `UPDATE asr_jobs SET
         state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
         stage = 'queued', progress = 0, lease_owner = NULL, lease_expires_at = NULL,
         error_message = 'The worker stopped before finishing.', updated_at = ?
       WHERE state IN ('transcribing','aligning','writing')
         AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
    )
    .run(now, now).changes
}

export function asrJobCounts(db: Db): Record<AsrJobState, number> {
  const counts: Record<AsrJobState, number> = {
    queued: 0,
    transcribing: 0,
    aligning: 0,
    writing: 0,
    completed: 0,
    failed: 0,
    canceled: 0,
  }
  const rows = db
    .query<{ state: AsrJobState; n: number }, []>(
      'SELECT state, COUNT(*) AS n FROM asr_jobs GROUP BY state',
    )
    .all()
  for (const row of rows) counts[row.state] = row.n
  return counts
}

export function getTranscript(
  db: Db,
  assetId: string,
  fileVersion: number,
): TranscriptWithSegments | null {
  const transcript =
    db
      .query<TranscriptRecord, Params>(
        `SELECT ${TRANSCRIPT_COLUMNS} FROM transcripts
         WHERE asset_id = ? AND file_version = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(assetId, fileVersion) ?? null
  if (!transcript) return null
  return { transcript, segments: segmentsFor(db, transcript.id) }
}

export function getTranscriptById(db: Db, id: string): TranscriptWithSegments | null {
  const transcript =
    db
      .query<TranscriptRecord, Params>(`SELECT ${TRANSCRIPT_COLUMNS} FROM transcripts WHERE id = ?`)
      .get(id) ?? null
  if (!transcript) return null
  return { transcript, segments: segmentsFor(db, transcript.id) }
}

function segmentsFor(db: Db, transcriptId: string): TranscriptSegmentRecord[] {
  return db
    .query<TranscriptSegmentRecord, Params>(
      `SELECT seq, start_ms AS startMs, end_ms AS endMs, text
       FROM transcript_segments WHERE transcript_id = ? ORDER BY seq ASC`,
    )
    .all(transcriptId)
}

export function searchTranscript(
  db: Db,
  transcriptId: string,
  query: string,
  limit = 50,
): TranscriptSegmentRecord[] {
  const escaped = query.replace(/[\\%_]/g, (match) => `\\${match}`)
  return db
    .query<TranscriptSegmentRecord, Params>(
      `SELECT seq, start_ms AS startMs, end_ms AS endMs, text
       FROM transcript_segments
       WHERE transcript_id = ? AND text LIKE ? ESCAPE '\\'
       ORDER BY seq ASC LIMIT ?`,
    )
    .all(transcriptId, `%${escaped}%`, limit)
}
