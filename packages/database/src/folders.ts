import type { SQLQueryBindings } from 'bun:sqlite'
import type { FolderSort } from '@mediavault/shared'
import { recordVoteEvent } from './contributions'
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
  createdAt?: number
}

const FOLDER_CTE = `
  WITH folder_base AS (
    SELECT
      f.id, f.library_id AS libraryId, f.parent_id AS parentId, f.name,
      f.relative_path AS relativePath, f.depth, f.asset_count AS assetCount,
      f.cover_asset_id AS coverAssetId,
      f.cover_width AS coverWidth,
      f.cover_height AS coverHeight,
      f.cover_poster_version AS coverPosterVersion,
      f.vote_count AS voteCount,
      f.created_at AS createdAt,
      (SELECT COUNT(*) FROM assets a
       WHERE a.folder_id = f.id AND a.deleted_at IS NULL AND a.kind = 'image') AS directImageCount,
      (SELECT COALESCE(SUM(a.view_count), 0) FROM assets a
       WHERE a.folder_id = f.id AND a.deleted_at IS NULL AND a.kind = 'image') AS viewCount
    FROM folders f
  ),
  folder_rated AS (
    SELECT id,
           ROUND(
             ((RANK() OVER (ORDER BY (CAST(viewCount AS REAL) / directImageCount) ASC) - 1
               + 0.5 * COUNT(*) OVER (PARTITION BY (CAST(viewCount AS REAL) / directImageCount))) * 100.0)
             / COUNT(*) OVER (),
             1
           ) AS rate
    FROM folder_base
    WHERE directImageCount > 0 AND viewCount > 0
  )
  SELECT fb.*, fr.rate AS rate
  FROM folder_base fb
  LEFT JOIN folder_rated fr ON fr.id = fb.id
`

function folderOrderSql(sort?: FolderSort): string {
  switch (sort) {
    case 'views':
      return 'fb.viewCount DESC, fb.name COLLATE NOCASE ASC, fb.id ASC'
    case 'votes':
      return 'fb.voteCount DESC, fb.name COLLATE NOCASE ASC, fb.id ASC'
    case 'date':
      return 'fb.createdAt DESC, fb.name COLLATE NOCASE ASC, fb.id DESC'
    case 'name':
      return 'fb.name COLLATE NOCASE ASC, fb.relativePath ASC'
    default:
      return 'fb.libraryId, fb.relativePath'
  }
}

export function upsertFolder(db: Db, input: UpsertFolderInput): string {
  const createdAt = input.createdAt ?? Date.now()
  const row = db
    .query<{ id: string }, Params>(
      `INSERT INTO folders (id, library_id, parent_id, relative_path, name, depth, last_seen_scan, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (library_id, relative_path) DO UPDATE SET
         parent_id = excluded.parent_id,
         name = excluded.name,
         depth = excluded.depth,
         last_seen_scan = excluded.last_seen_scan,
         created_at = CASE WHEN folders.created_at = 0 THEN excluded.created_at ELSE folders.created_at END
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
      createdAt,
    )
  if (!row) throw new Error(`folder upsert returned no row for ${input.relativePath}`)
  return row.id
}

export function listFolders(db: Db, libraryId: string, sort?: FolderSort): FolderRecord[] {
  return db
    .query<FolderRecord, Params>(
      `${FOLDER_CTE} WHERE fb.libraryId = ? ORDER BY ${folderOrderSql(sort)}`,
    )
    .all(libraryId)
}

export function listAllFolders(db: Db, sort?: FolderSort): FolderRecord[] {
  return db.query<FolderRecord, []>(`${FOLDER_CTE} ORDER BY ${folderOrderSql(sort)}`).all()
}

export function voteFolder(db: Db, folderId: string, now = Date.now()): FolderRecord | null {
  let updated = false
  db.transaction(() => {
    const row = db
      .query<{ name: string }, Params>(
        'UPDATE folders SET vote_count = vote_count + 1 WHERE id = ? RETURNING name',
      )
      .get(folderId)
    if (!row) return
    recordVoteEvent(db, 'folder', folderId, row.name, now)
    updated = true
  }).immediate()
  if (!updated) return null
  return getFolder(db, folderId)
}

export function getFolder(db: Db, id: string): FolderRecord | null {
  return db.query<FolderRecord, Params>(`${FOLDER_CTE} WHERE fb.id = ?`).get(id) ?? null
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

interface CoverCandidate {
  id: string
  width: number | null
  height: number | null
  posterVersion: number
  takenAt: number
}

/**
 * Selects the middle image in deterministic filename order (`Math.floor(len / 2)`):
 * index 0 for 1 photo, index 1 for 2 or 3 photos, upper-middle for even counts.
 */
export function pickMiddleCover<T>(sorted: T[]): T | null {
  if (sorted.length === 0) return null
  return sorted[Math.floor(sorted.length / 2)] ?? null
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

  const imagesByFolder = new Map<string, CoverCandidate[]>()
  const sortedImages = db
    .query<CoverCandidate & { folderId: string }, Params>(
      `SELECT folder_id AS folderId, id, width, height, poster_version AS posterVersion, taken_at AS takenAt
       FROM assets
       WHERE library_id = ? AND deleted_at IS NULL AND folder_id IS NOT NULL AND kind = 'image'
       ORDER BY folder_id, filename COLLATE NOCASE ASC, id ASC`,
    )
    .all(libraryId)
  for (const row of sortedImages) {
    const list = imagesByFolder.get(row.folderId) ?? []
    list.push({
      id: row.id,
      width: row.width,
      height: row.height,
      posterVersion: row.posterVersion,
      takenAt: row.takenAt,
    })
    imagesByFolder.set(row.folderId, list)
  }

  const subtree = new Map<string, number>()
  const covers = new Map<string, CoverCandidate>()
  const deepestFirst = [...folders].sort((a, b) => b.depth - a.depth)
  for (const folder of deepestFirst) {
    const total = (direct.get(folder.id) ?? 0) + (subtree.get(folder.id) ?? 0)
    subtree.set(folder.id, total)
    if (folder.parentId) {
      subtree.set(folder.parentId, (subtree.get(folder.parentId) ?? 0) + total)
    }

    const middle = pickMiddleCover(imagesByFolder.get(folder.id) ?? [])
    if (middle) {
      covers.set(folder.id, middle)
      continue
    }
    let inherited: CoverCandidate | undefined
    for (const childId of children.get(folder.id) ?? []) {
      const candidate = covers.get(childId)
      if (candidate && (!inherited || candidate.takenAt > inherited.takenAt)) inherited = candidate
    }
    if (inherited) covers.set(folder.id, inherited)
  }

  const update = db.query<null, Params>(
    `UPDATE folders SET
       asset_count = ?,
       cover_asset_id = ?,
       cover_width = ?,
       cover_height = ?,
       cover_poster_version = ?
     WHERE id = ?`,
  )
  db.transaction(() => {
    for (const folder of folders) {
      const cover = covers.get(folder.id)
      update.run(
        subtree.get(folder.id) ?? 0,
        cover?.id ?? null,
        cover?.width ?? null,
        cover?.height ?? null,
        cover?.posterVersion ?? 1,
        folder.id,
      )
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
