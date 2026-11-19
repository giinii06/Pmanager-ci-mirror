import type { SQLQueryBindings } from 'bun:sqlite'
import type { Db } from './db'
import type { RecoveryLogRecord, ScanCheckpointRecord, ScanRunRecord } from './types'

type Params = SQLQueryBindings[]

export function createScanRun(
  db: Db,
  input: {
    id: string
    libraryId: string
    rootPath: string
    phase: string
    status: string
    resumedFromRunId?: string | null
    mountIdentity?: string | null
    startedAt: number
  },
): void {
  db.query<null, Params>(
    `INSERT INTO scan_runs (
       id, library_id, root_path, phase, status, resumed_from_run_id,
       mount_identity, started_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.libraryId,
    input.rootPath,
    input.phase,
    input.status,
    input.resumedFromRunId ?? null,
    input.mountIdentity ?? null,
    input.startedAt,
    input.startedAt,
  )
}

export function updateScanRun(
  db: Db,
  id: string,
  patch: {
    phase?: string
    status?: string
    filesSeen?: number
    filesAdded?: number
    filesUpdated?: number
    filesSkipped?: number
    filesRemoved?: number
    readErrors?: number
    errorMessage?: string | null
    mountIdentity?: string | null
    missingCount?: number
    missingRatio?: number
    authoritativeVerified?: number
    healthState?: string | null
    completedAt?: number | null
    updatedAt: number
  },
): void {
  const sets = ['updated_at = ?']
  const params: SQLQueryBindings[] = [patch.updatedAt]
  if (patch.phase !== undefined) {
    sets.push('phase = ?')
    params.push(patch.phase)
  }
  if (patch.status !== undefined) {
    sets.push('status = ?')
    params.push(patch.status)
  }
  if (patch.filesSeen !== undefined) {
    sets.push('files_seen = ?')
    params.push(patch.filesSeen)
  }
  if (patch.filesAdded !== undefined) {
    sets.push('files_added = ?')
    params.push(patch.filesAdded)
  }
  if (patch.filesUpdated !== undefined) {
    sets.push('files_updated = ?')
    params.push(patch.filesUpdated)
  }
  if (patch.filesSkipped !== undefined) {
    sets.push('files_skipped = ?')
    params.push(patch.filesSkipped)
  }
  if (patch.filesRemoved !== undefined) {
    sets.push('files_removed = ?')
    params.push(patch.filesRemoved)
  }
  if (patch.readErrors !== undefined) {
    sets.push('read_errors = ?')
    params.push(patch.readErrors)
  }
  if (patch.errorMessage !== undefined) {
    sets.push('error_message = ?')
    params.push(patch.errorMessage)
  }
  if (patch.mountIdentity !== undefined) {
    sets.push('mount_identity = ?')
    params.push(patch.mountIdentity)
  }
  if (patch.missingCount !== undefined) {
    sets.push('missing_count = ?')
    params.push(patch.missingCount)
  }
  if (patch.missingRatio !== undefined) {
    sets.push('missing_ratio = ?')
    params.push(patch.missingRatio)
  }
  if (patch.authoritativeVerified !== undefined) {
    sets.push('authoritative_verified = ?')
    params.push(patch.authoritativeVerified)
  }
  if (patch.healthState !== undefined) {
    sets.push('health_state = ?')
    params.push(patch.healthState)
  }
  if (patch.completedAt !== undefined) {
    sets.push('completed_at = ?')
    params.push(patch.completedAt)
  }
  db.query<null, Params>(`UPDATE scan_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
}

export function getLatestScanRun(db: Db, libraryId: string): ScanRunRecord | null {
  return (
    db
      .query<ScanRunRecord, Params>(
        `SELECT id, library_id AS libraryId, root_path AS rootPath, phase, status,
                resumed_from_run_id AS resumedFromRunId, files_seen AS filesSeen,
                files_added AS filesAdded, files_updated AS filesUpdated,
                files_skipped AS filesSkipped, files_removed AS filesRemoved,
                read_errors AS readErrors, error_message AS errorMessage,
                mount_identity AS mountIdentity, missing_count AS missingCount,
                missing_ratio AS missingRatio, authoritative_verified AS authoritativeVerified,
                health_state AS healthState,
                started_at AS startedAt, updated_at AS updatedAt, completed_at AS completedAt
         FROM scan_runs WHERE library_id = ? ORDER BY started_at DESC LIMIT 1`,
      )
      .get(libraryId) ?? null
  )
}

export function getScanCheckpoint(db: Db, libraryId: string): ScanCheckpointRecord | null {
  return (
    db
      .query<ScanCheckpointRecord, Params>(
        `SELECT library_id AS libraryId, scan_id AS scanId, started_at AS startedAt,
                last_dir_rel AS lastDirRel, last_rel_path AS lastRelPath,
                processed_files AS processedFiles, total_estimate AS totalEstimate,
                updated_at AS updatedAt
         FROM scan_checkpoints WHERE library_id = ?`,
      )
      .get(libraryId) ?? null
  )
}

export function upsertScanCheckpoint(
  db: Db,
  checkpoint: ScanCheckpointRecord,
): void {
  db.query<null, Params>(
    `INSERT INTO scan_checkpoints (
       library_id, scan_id, started_at, last_dir_rel, last_rel_path,
       processed_files, total_estimate, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (library_id) DO UPDATE SET
       scan_id = excluded.scan_id,
       started_at = excluded.started_at,
       last_dir_rel = excluded.last_dir_rel,
       last_rel_path = excluded.last_rel_path,
       processed_files = excluded.processed_files,
       total_estimate = excluded.total_estimate,
       updated_at = excluded.updated_at`,
  ).run(
    checkpoint.libraryId,
    checkpoint.scanId,
    checkpoint.startedAt,
    checkpoint.lastDirRel,
    checkpoint.lastRelPath,
    checkpoint.processedFiles,
    checkpoint.totalEstimate,
    checkpoint.updatedAt,
  )
}

export function clearScanCheckpoint(db: Db, libraryId: string): void {
  db.query<null, Params>('DELETE FROM scan_checkpoints WHERE library_id = ?').run(libraryId)
}

export function recordRecoveryLog(
  db: Db,
  entry: {
    workerId: string
    recoveredJobs: number
    cleanedTempFiles: number
    requeuedThumbnails: number
    dbIntegrity: string
    createdAt: number
  },
): void {
  db.query<null, Params>(
    `INSERT INTO recovery_logs (
       worker_id, recovered_jobs, cleaned_temp_files, requeued_thumbnails, db_integrity, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.workerId,
    entry.recoveredJobs,
    entry.cleanedTempFiles,
    entry.requeuedThumbnails,
    entry.dbIntegrity,
    entry.createdAt,
  )
}

export function getLatestRecoveryLog(db: Db): RecoveryLogRecord | null {
  return (
    db
      .query<RecoveryLogRecord, []>(
        `SELECT id, worker_id AS workerId, recovered_jobs AS recoveredJobs,
                cleaned_temp_files AS cleanedTempFiles, requeued_thumbnails AS requeuedThumbnails,
                db_integrity AS dbIntegrity, created_at AS createdAt
         FROM recovery_logs ORDER BY id DESC LIMIT 1`,
      )
      .get() ?? null
  )
}
