import type { SQLQueryBindings } from 'bun:sqlite'
import type { Db } from './db'
import type { FolderRecord } from './types'

type Params = SQLQueryBindings[]

export interface UpsertFolderInput {
  id: string
  libraryId: string
  parentId: string | null
  relativePath: string
  name: string
  depth: number
  scanId: string
}

const FOLDER_SELECT = `
  f.id, f.library_id AS libraryId, f.parent_id AS parentId, f.name,
  f.relative_path AS relativePath, f.depth, f.asset_count AS assetCount,
  f.cover_asset_id AS coverAssetId
`

export function upsertFolder(db: Db, input: UpsertFolderInput): string {
  const row = db
    .query<{ id: string }, Params>(
      `INSERT INTO folders (id, library_id, parent_id, relative_path, name, depth, last_seen_scan)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (library_id, relative_path) DO UPDATE SET
         parent_id = excluded.parent_id,
         name = excluded.name,
         depth = excluded.depth,
         last_seen_scan = excluded.last_seen_scan
       RETURNING id`,
    )
    .get(
      input.id,
      input.libraryId,
      input.parentId,
      input.relativePath,
      input.name,
      input.depth,
      input.scanId,
    )
  if (!row) throw new Error(`folder upsert returned no row for ${input.relativePath}`)
  return row.id
}

export function listFolders(db: Db, libraryId: string): FolderRecord[] {
  return db
    .query<FolderRecord, Params>(
      `SELECT ${FOLDER_SELECT} FROM folders f WHERE f.library_id = ? ORDER BY f.relative_path`,
    )
    .all(libraryId)
}

export function listAllFolders(db: Db): FolderRecord[] {
  return db
    .query<FolderRecord, []>(
      `SELECT ${FOLDER_SELECT} FROM folders f ORDER BY f.library_id, f.relative_path`,
    )
    .all()
}

export function getFolder(db: Db, id: string): FolderRecord | null {
  return (
    db.query<FolderRecord, Params>(`SELECT ${FOLDER_SELECT} FROM folders f WHERE f.id = ?`).get(id) ??
    null
  )
}

export function breadcrumb(db: Db, folderId: string): FolderRecord[] {
  const trail: FolderRecord[] = []
  let current = getFolder(db, folderId)
  while (current) {
    trail.unshift(current)
    current = current.parentId ? getFolder(db, current.parentId) : null
  }
  return trail
}

export function recomputeFolderCounts(db: Db, libraryId: string): void {
  const direct = new Map<string, number>()
  const rows = db
    .query<{ folderId: string; n: number }, Params>(
      `SELECT folder_id AS folderId, COUNT(*) AS n FROM assets
       WHERE library_id = ? AND deleted_at IS NULL AND folder_id IS NOT NULL
       GROUP BY folder_id`,
    )
    .all(libraryId)
  for (const row of rows) direct.set(row.folderId, row.n)

  const folders = listFolders(db, libraryId)
  const children = new Map<string, string[]>()
  for (const folder of folders) {
    if (!folder.parentId) continue
    const list = children.get(folder.parentId) ?? []
    list.push(folder.id)
    children.set(folder.parentId, list)
  }

  const latest = new Map<string, { id: string; takenAt: number }>()
  const newest = db
    .query<{ folderId: string; id: string; takenAt: number }, Params>(
      `SELECT folder_id AS folderId, id, taken_at AS takenAt FROM assets
       WHERE library_id = ? AND deleted_at IS NULL AND folder_id IS NOT NULL
       ORDER BY taken_at DESC, id DESC`,
    )
    .all(libraryId)
  for (const row of newest) {
    if (!latest.has(row.folderId)) latest.set(row.folderId, { id: row.id, takenAt: row.takenAt })
  }

  const subtree = new Map<string, number>()
  const covers = new Map<string, { id: string; takenAt: number }>()
  const deepestFirst = [...folders].sort((a, b) => b.depth - a.depth)
  for (const folder of deepestFirst) {
    const total = (direct.get(folder.id) ?? 0) + (subtree.get(folder.id) ?? 0)
    subtree.set(folder.id, total)
    if (folder.parentId) {
      subtree.set(folder.parentId, (subtree.get(folder.parentId) ?? 0) + total)
    }

    let best = latest.get(folder.id)
    for (const childId of children.get(folder.id) ?? []) {
      const candidate = covers.get(childId)
      if (candidate && (!best || candidate.takenAt > best.takenAt)) best = candidate
    }
    if (best) covers.set(folder.id, best)
  }

  const update = db.query<null, Params>(
    'UPDATE folders SET asset_count = ?, cover_asset_id = ? WHERE id = ?',
  )
  db.transaction(() => {
    for (const folder of folders) {
      update.run(subtree.get(folder.id) ?? 0, covers.get(folder.id)?.id ?? null, folder.id)
    }
  })()
}

export function deleteStaleFolders(db: Db, libraryId: string, scanId: string): number {
  const remove = db.query<null, Params>(
    `DELETE FROM folders
     WHERE library_id = ? AND (last_seen_scan IS NULL OR last_seen_scan <> ?)
       AND NOT EXISTS (SELECT 1 FROM folders child WHERE child.parent_id = folders.id)`,
  )
  let deleted = 0
  for (let pass = 0; pass < 64; pass += 1) {
    const result = remove.run(libraryId, scanId)
    deleted += result.changes
    if (result.changes === 0) break
  }
  return deleted
}
