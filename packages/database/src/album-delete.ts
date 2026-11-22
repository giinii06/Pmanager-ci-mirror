import type { SQLQueryBindings } from 'bun:sqlite'
import { newId } from '@mediavault/shared'
import type { Db } from './db'
import { createDeleteMutation } from './file-mutations'
import { getFolder } from './folders'

type Params = SQLQueryBindings[]
type Batch = { id: string; folderId: string; userId: string; targetCount: number }

export interface AlbumDeleteStatus {
  id: string
  folderId: string
  total: number
  completed: number
  failed: number
  pending: number
  state: 'pending' | 'completed' | 'failed'
}

export function getAlbumDeleteStatus(db: Db, id: string, userId: string): AlbumDeleteStatus | null {
  const row = db.query<{
    id: string; folderId: string; total: number; completed: number; failed: number
  }, Params>(
    `SELECT b.id, b.folder_id AS folderId, b.target_count AS total,
            COALESCE(SUM(CASE WHEN m.state = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
            COALESCE(SUM(CASE WHEN m.state IN ('blocked', 'cancelled_pre_commit') THEN 1 ELSE 0 END), 0) AS failed
     FROM album_delete_batches b
     JOIN album_delete_items i ON i.batch_id = b.id
     JOIN file_mutations m ON m.id = i.mutation_id
     WHERE b.id = ? AND b.user_id = ?
     GROUP BY b.id`,
  ).get(id, userId)
  if (!row) return null
  const pending = row.total - row.completed - row.failed
  return {
    ...row, pending,
    state: row.failed > 0 ? 'failed' : pending > 0 ? 'pending' : 'completed',
  }
}

export type CreateAlbumDeleteResult =
  | { status: 'ok'; batch: AlbumDeleteStatus; created: boolean }
  | { status: 'not_found' | 'empty' | 'conflict' | 'too_large' }

/**
 * Snapshot direct image assets only. Nested images and video assets are not eligible.
 * All mutation rows and the request key commit atomically, surviving disconnects.
 */
export function queueAlbumPhotoDeletion(
  db: Db,
  input: { folderId: string; userId: string; requestKey: string; now: number },
): CreateAlbumDeleteResult {
  return db.transaction(() => {
    const existing = db.query<Batch, Params>(
      `SELECT id, folder_id AS folderId, user_id AS userId, target_count AS targetCount
       FROM album_delete_batches WHERE request_key = ?`,
    ).get(input.requestKey)
    if (existing) {
      const batch = getAlbumDeleteStatus(db, existing.id, input.userId)
      return batch && existing.folderId === input.folderId
        ? { status: 'ok', batch, created: false }
        : { status: 'conflict' }
    }

    const folder = getFolder(db, input.folderId)
    if (!folder) return { status: 'not_found' }
    const active = db.query<{ id: string }, Params>(
      `SELECT b.id FROM album_delete_batches b
       JOIN album_delete_items i ON i.batch_id = b.id
       JOIN file_mutations m ON m.id = i.mutation_id
       WHERE b.folder_id = ?
         AND m.state NOT IN ('completed','blocked','cancelled_pre_commit') LIMIT 1`,
    ).get(folder.id)
    if (active) return { status: 'conflict' }

    const assets = db.query<{
      id: string; libraryId: string; fileVersion: number; sourceRel: string
    }, Params>(
      `SELECT id, library_id AS libraryId, file_version AS fileVersion,
              relative_path AS sourceRel
       FROM assets
       WHERE folder_id = ? AND kind = 'image' AND deleted_at IS NULL
       ORDER BY id ASC`,
    ).all(input.folderId)
    if (assets.length === 0) return { status: 'empty' }
    if (assets.length > 10_000) return { status: 'too_large' }

    const ids = assets.map((asset) => asset.id)
    const conflicts = db.query<{ n: number }, Params>(
      `SELECT COUNT(*) AS n FROM file_mutations m
       WHERE m.asset_id IN (${ids.map(() => '?').join(',')})
         AND m.state NOT IN ('completed','blocked','cancelled_pre_commit')`,
    ).get(...ids)
    if ((conflicts?.n ?? 0) > 0) return { status: 'conflict' }

    const id = newId()
    db.query<null, Params>(
      `INSERT INTO album_delete_batches
       (id, folder_id, user_id, request_key, target_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, folder.id, input.userId, input.requestKey, assets.length, input.now)
    const addItem = db.query<null, Params>(
      'INSERT INTO album_delete_items (batch_id, mutation_id, asset_id) VALUES (?, ?, ?)',
    )
    for (const asset of assets) {
      const mutation = createDeleteMutation(db, {
        assetId: asset.id, libraryId: asset.libraryId, userId: input.userId,
        requestKey: `${input.requestKey}:${asset.id}`,
        requestedFileVersion: asset.fileVersion,
        sourceRel: asset.sourceRel, now: input.now,
      })
      addItem.run(id, mutation.record.id, asset.id)
    }
    const batch = getAlbumDeleteStatus(db, id, input.userId)!
    return { status: 'ok', batch, created: true }
  }).immediate()
}
