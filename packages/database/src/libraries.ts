import type { SQLQueryBindings } from 'bun:sqlite'
import type { ScanState } from '@mediavault/shared'
import type { Db } from './db'
import type { LibraryRecord } from './types'

type Params = SQLQueryBindings[]

const LIBRARY_SELECT = `
  l.id, l.name, l.root_path AS rootPath, l.created_at AS createdAt,
  l.last_scan_at AS lastScanAt, l.scan_state AS scanState, l.scanned_files AS scannedFiles,
  l.last_error AS lastError,
  (SELECT COUNT(*) FROM assets a WHERE a.library_id = l.id AND a.deleted_at IS NULL) AS assetCount,
  (SELECT COUNT(*) FROM folders f WHERE f.library_id = l.id) AS folderCount
`

export function listLibraries(db: Db): LibraryRecord[] {
  return db
    .query<LibraryRecord, []>(`SELECT ${LIBRARY_SELECT} FROM libraries l ORDER BY l.created_at`)
    .all()
}

export function getLibrary(db: Db, id: string): LibraryRecord | null {
  return (
    db.query<LibraryRecord, Params>(`SELECT ${LIBRARY_SELECT} FROM libraries l WHERE l.id = ?`).get(id) ??
    null
  )
}

export function findLibraryByRoot(db: Db, rootPath: string): LibraryRecord | null {
  return (
    db
      .query<LibraryRecord, Params>(`SELECT ${LIBRARY_SELECT} FROM libraries l WHERE l.root_path = ?`)
      .get(rootPath) ?? null
  )
}

export interface NewLibrary {
  id: string
  name: string
  rootPath: string
  createdAt: number
}

export function createLibrary(db: Db, library: NewLibrary): void {
  db.query<null, Params>(
    'INSERT INTO libraries (id, name, root_path, created_at) VALUES (?, ?, ?, ?)',
  ).run(library.id, library.name, library.rootPath, library.createdAt)
}

export function deleteLibrary(db: Db, id: string): boolean {
  return db.query<null, Params>('DELETE FROM libraries WHERE id = ?').run(id).changes > 0
}

export function setScanState(
  db: Db,
  id: string,
  state: ScanState,
  error: string | null = null,
): void {
  db.query<null, Params>('UPDATE libraries SET scan_state = ?, last_error = ? WHERE id = ?').run(
    state,
    error,
    id,
  )
}

export function updateScanProgress(db: Db, id: string, scannedFiles: number): void {
  db.query<null, Params>('UPDATE libraries SET scanned_files = ? WHERE id = ?').run(
    scannedFiles,
    id,
  )
}

export function finishScan(db: Db, id: string, now: number, scannedFiles: number): void {
  db.query<null, Params>(
    `UPDATE libraries SET scan_state = 'idle', last_scan_at = ?, scanned_files = ?, last_error = NULL
     WHERE id = ?`,
  ).run(now, scannedFiles, id)
}
