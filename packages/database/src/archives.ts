import type { SQLQueryBindings } from 'bun:sqlite'
import type { ArchiveJobState } from '@mediavault/shared'
import type { Db } from './db'
import type { ArchiveJobRecord } from './types'

type Params = SQLQueryBindings[]

const MAX_ARCHIVE_HISTORY = 5

/** Do not delete active worker jobs: only terminal history outside the newest five may be pruned. */
export function pruneArchiveJobHistory(db: Db): number {
  return db.query<null, Params>(
    `DELETE FROM archive_jobs
     WHERE state IN ('completed', 'failed_password', 'failed')
       AND id NOT IN (
         SELECT id FROM archive_jobs ORDER BY updated_at DESC, id DESC LIMIT ?
       )`,
  ).run(MAX_ARCHIVE_HISTORY).changes
}

const ARCHIVE_SELECT = `
  id, library_id AS libraryId, archive_path AS archivePath, state,
  password_used AS passwordUsed, extracted_files AS extractedFiles,
  converted_images AS convertedImages, converted_videos AS convertedVideos,
  error_message AS errorMessage, signature,
  created_at AS createdAt, updated_at AS updatedAt
`

export interface CreateArchiveJobInput {
  id: string
  libraryId: string
  archivePath: string
  signature: string
}

export function getArchiveJob(db: Db, id: string): ArchiveJobRecord | null {
  return (
    db
      .query<ArchiveJobRecord, Params>(`SELECT ${ARCHIVE_SELECT} FROM archive_jobs WHERE id = ?`)
      .get(id) ?? null
  )
}

export function findArchiveJobBySignature(
  db: Db,
  libraryId: string,
  archivePath: string,
  signature: string,
): ArchiveJobRecord | null {
  return (
    db
      .query<ArchiveJobRecord, Params>(
        `SELECT ${ARCHIVE_SELECT} FROM archive_jobs
         WHERE library_id = ? AND archive_path = ? AND signature = ?`,
      )
      .get(libraryId, archivePath, signature) ?? null
  )
}

export function enqueueArchiveJobIfNeeded(
  db: Db,
  input: CreateArchiveJobInput,
  now: number,
): { created: boolean; record: ArchiveJobRecord } {
  const existing = findArchiveJobBySignature(db, input.libraryId, input.archivePath, input.signature)
  if (existing && existing.state !== 'failed') {
    return { created: false, record: existing }
  }
  if (existing && existing.state === 'failed') {
    db.query<null, Params>(
      `UPDATE archive_jobs SET state = 'queued', error_message = NULL, updated_at = ? WHERE id = ?`,
    ).run(now, existing.id)
    pruneArchiveJobHistory(db)
    return { created: true, record: getArchiveJob(db, existing.id)! }
  }

  db.query<null, Params>(
    `INSERT INTO archive_jobs (
       id, library_id, archive_path, state, signature, created_at, updated_at
     ) VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
  ).run(input.id, input.libraryId, input.archivePath, input.signature, now, now)
  pruneArchiveJobHistory(db)

  return { created: true, record: getArchiveJob(db, input.id)! }
}

export function updateArchiveJob(
  db: Db,
  id: string,
  patch: {
    state: ArchiveJobState
    passwordUsed?: string | null
    extractedFiles?: number
    convertedImages?: number
    convertedVideos?: number
    errorMessage?: string | null
  },
  now: number,
): ArchiveJobRecord | null {
  db.query<null, Params>(
    `UPDATE archive_jobs SET
       state = ?,
       password_used = COALESCE(?, password_used),
       extracted_files = COALESCE(?, extracted_files),
       converted_images = COALESCE(?, converted_images),
       converted_videos = COALESCE(?, converted_videos),
       error_message = ?,
       updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.state,
    patch.passwordUsed === undefined ? null : patch.passwordUsed,
    patch.extractedFiles ?? null,
    patch.convertedImages ?? null,
    patch.convertedVideos ?? null,
    patch.errorMessage === undefined ? null : patch.errorMessage,
    now,
    id,
  )
  if (patch.state === 'completed' || patch.state === 'failed_password' || patch.state === 'failed') {
    pruneArchiveJobHistory(db)
  }
  return getArchiveJob(db, id)
}

export function listArchiveJobs(db: Db, limit = MAX_ARCHIVE_HISTORY): ArchiveJobRecord[] {
  pruneArchiveJobHistory(db)
  return db
    .query<ArchiveJobRecord, Params>(
      `SELECT ${ARCHIVE_SELECT} FROM archive_jobs ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
    .all(Math.min(MAX_ARCHIVE_HISTORY, Math.max(0, limit)))
}
