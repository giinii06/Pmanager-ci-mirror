import type { SQLQueryBindings } from 'bun:sqlite'
import type { Db } from './db'
import type { LibraryHealthRecord, LibraryHealthState } from './types'

type Params = SQLQueryBindings[]

const SELECT_HEALTH = `
  SELECT library_id AS libraryId, state, root_identity AS rootIdentity,
         last_success_at AS lastSuccessAt, last_error_code AS lastErrorCode,
         checked_at AS checkedAt, consecutive_failures AS consecutiveFailures
  FROM library_health`

export function getLibraryHealth(db: Db, libraryId: string): LibraryHealthRecord | null {
  return (
    db
      .query<LibraryHealthRecord, Params>(`${SELECT_HEALTH} WHERE library_id = ?`)
      .get(libraryId) ?? null
  )
}

export function listLibraryHealth(db: Db): LibraryHealthRecord[] {
  return db.query<LibraryHealthRecord, []>(SELECT_HEALTH).all()
}

export function markLibraryHealthy(
  db: Db,
  input: { libraryId: string; rootIdentity: string | null; now: number },
): LibraryHealthRecord {
  db.query<null, Params>(
    `INSERT INTO library_health (
       library_id, state, root_identity, last_success_at, last_error_code,
       checked_at, consecutive_failures
     ) VALUES (?, 'ONLINE', ?, ?, NULL, ?, 0)
     ON CONFLICT(library_id) DO UPDATE SET
       state = 'ONLINE',
       root_identity = COALESCE(excluded.root_identity, library_health.root_identity),
       last_success_at = excluded.last_success_at,
       last_error_code = NULL,
       checked_at = excluded.checked_at,
       consecutive_failures = 0`,
  ).run(input.libraryId, input.rootIdentity, input.now, input.now)
  return getLibraryHealth(db, input.libraryId)!
}

export function markLibraryVerified(
  db: Db,
  input: { libraryId: string; rootIdentity: string | null; now: number },
): LibraryHealthRecord {
  db.query<null, Params>(
    `INSERT INTO library_health (
       library_id, state, root_identity, last_error_code, checked_at, consecutive_failures
     ) VALUES (?, 'ONLINE', ?, NULL, ?, 0)
     ON CONFLICT(library_id) DO UPDATE SET
       state = 'ONLINE',
       root_identity = COALESCE(excluded.root_identity, library_health.root_identity),
       last_error_code = NULL,
       checked_at = excluded.checked_at,
       consecutive_failures = 0`,
  ).run(input.libraryId, input.rootIdentity, input.now)
  return getLibraryHealth(db, input.libraryId)!
}

export function markLibraryFailure(
  db: Db,
  input: {
    libraryId: string
    state: Exclude<LibraryHealthState, 'ONLINE'>
    errorCode: string
    now: number
    rootIdentity?: string | null
  },
): LibraryHealthRecord {
  db.query<null, Params>(
    `INSERT INTO library_health (
       library_id, state, root_identity, last_error_code, checked_at,
       consecutive_failures
     ) VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(library_id) DO UPDATE SET
       state = excluded.state,
       root_identity = COALESCE(excluded.root_identity, library_health.root_identity),
       last_error_code = excluded.last_error_code,
       checked_at = excluded.checked_at,
       consecutive_failures = library_health.consecutive_failures + 1`,
  ).run(
    input.libraryId,
    input.state,
    input.rootIdentity ?? null,
    input.errorCode,
    input.now,
  )
  return getLibraryHealth(db, input.libraryId)!
}
