import type { SQLQueryBindings } from 'bun:sqlite'
import type { Db } from './db'
import type { CacheCleanupRunInput, CacheCleanupRunRecord, DiagnosticsRunRecord } from './types'

type Params = SQLQueryBindings[]

const DIAGNOSTICS_SELECT = `
  id, user_id AS userId, format, size_bytes AS sizeBytes, created_at AS createdAt
`

const CACHE_RUN_SELECT = `
  id, user_id AS userId, types_json AS typesJson, candidate_bytes AS candidateBytes,
  deleted_bytes AS deletedBytes, deleted_files AS deletedFiles, created_at AS createdAt
`

export function recordDiagnosticsRun(
  db: Db,
  input: { id: string; userId: string | null; format: 'json' | 'md'; sizeBytes: number; now: number },
): void {
  db.query<null, Params>(
    `INSERT INTO diagnostics_runs (id, user_id, format, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.id, input.userId, input.format, input.sizeBytes, input.now)
}

export function listDiagnosticsRuns(db: Db, limit = 50): DiagnosticsRunRecord[] {
  return db
    .query<DiagnosticsRunRecord, Params>(
      `SELECT ${DIAGNOSTICS_SELECT} FROM diagnostics_runs ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit)
}

/** The audit trail is useful, but a report downloaded every day must not grow forever. */
export function pruneDiagnosticsRuns(db: Db, keep = 50): number {
  return db
    .query<null, Params>(
      `DELETE FROM diagnostics_runs WHERE id NOT IN (
         SELECT id FROM diagnostics_runs ORDER BY created_at DESC LIMIT ?
       )`,
    )
    .run(keep).changes
}

export function recordCacheCleanupRun(db: Db, input: CacheCleanupRunInput): void {
  db.query<null, Params>(
    `INSERT INTO cache_cleanup_runs (
       id, user_id, types_json, candidate_bytes, deleted_bytes, deleted_files, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.userId,
    JSON.stringify(input.types),
    input.candidateBytes,
    input.deletedBytes,
    input.deletedFiles,
    input.now,
  )
}

export function listCacheCleanupRuns(db: Db, limit = 20): CacheCleanupRunRecord[] {
  return db
    .query<CacheCleanupRunRecord, Params>(
      `SELECT ${CACHE_RUN_SELECT} FROM cache_cleanup_runs ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit)
}

export function pruneCacheCleanupRuns(db: Db, keep = 100): number {
  return db
    .query<null, Params>(
      `DELETE FROM cache_cleanup_runs WHERE id NOT IN (
         SELECT id FROM cache_cleanup_runs ORDER BY created_at DESC LIMIT ?
       )`,
    )
    .run(keep).changes
}
