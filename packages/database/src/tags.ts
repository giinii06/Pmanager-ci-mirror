import type { SQLQueryBindings } from 'bun:sqlite'
import type { TagDTO } from '@mediavault/shared'
import type { Db } from './db'
import type { TagRecord, TagSummaryRecord } from './types'

type Params = SQLQueryBindings[]

export function listTags(db: Db): TagSummaryRecord[] {
  return db
    .query<TagSummaryRecord, []>(
      `SELECT t.id, t.name, t.created_at AS createdAt,
         (SELECT COUNT(*) FROM asset_tags at
          JOIN assets a ON a.id = at.asset_id
          WHERE at.tag_id = t.id AND a.deleted_at IS NULL AND a.kind = 'video') AS assetCount,
         cover.id AS coverAssetId,
         cover.posterVersion AS coverPosterVersion
       FROM tags t
       LEFT JOIN (
         SELECT at.tag_id AS tagId, a.id, a.poster_version AS posterVersion,
                ROW_NUMBER() OVER (
                  PARTITION BY at.tag_id
                  ORDER BY
                    CASE WHEN a.view_count > 0 AND a.watch_time_ms > 0
                      THEN CAST(a.watch_time_ms AS REAL) / a.view_count
                      ELSE -1 END DESC,
                    a.taken_at DESC,
                    a.id DESC
                ) AS rn
         FROM asset_tags at
         JOIN assets a ON a.id = at.asset_id
         WHERE a.deleted_at IS NULL AND a.kind = 'video'
       ) cover ON cover.tagId = t.id AND cover.rn = 1
       ORDER BY t.name COLLATE NOCASE ASC, t.id ASC`,
    )
    .all()
}

export function getTag(db: Db, id: string): TagRecord | null {
  return (
    db
      .query<TagRecord, Params>('SELECT id, name, created_at AS createdAt FROM tags WHERE id = ?')
      .get(id) ?? null
  )
}

export function findTagByName(db: Db, name: string): TagRecord | null {
  return (
    db
      .query<TagRecord, Params>(
        'SELECT id, name, created_at AS createdAt FROM tags WHERE name = ? COLLATE NOCASE',
      )
      .get(name.trim()) ?? null
  )
}

export function createTag(db: Db, id: string, rawName: string, now: number): TagRecord {
  const name = rawName.trim()
  if (!name) throw new Error('Tag name cannot be empty')
  db.query<null, Params>('INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)').run(
    id,
    name,
    now,
  )
  return { id, name, createdAt: now }
}

export function renameTag(db: Db, id: string, rawName: string): TagRecord | null {
  const name = rawName.trim()
  if (!name) throw new Error('Tag name cannot be empty')
  const result = db.query<null, Params>('UPDATE tags SET name = ? WHERE id = ?').run(name, id)
  if (result.changes === 0) return null
  return getTag(db, id)
}

export function deleteTag(db: Db, id: string): boolean {
  return db.query<null, Params>('DELETE FROM tags WHERE id = ?').run(id).changes > 0
}

export function addTagToAsset(db: Db, assetId: string, tagId: string, now: number): void {
  db.query<null, Params>(
    `INSERT INTO asset_tags (asset_id, tag_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT (asset_id, tag_id) DO NOTHING`,
  ).run(assetId, tagId, now)
}

export function removeTagFromAsset(db: Db, assetId: string, tagId: string): boolean {
  return (
    db.query<null, Params>('DELETE FROM asset_tags WHERE asset_id = ? AND tag_id = ?').run(assetId, tagId)
      .changes > 0
  )
}

export function listTagsForAssets(db: Db, assetIds: string[]): Map<string, TagDTO[]> {
  const map = new Map<string, TagDTO[]>()
  if (assetIds.length === 0) return map
  const placeholders = assetIds.map(() => '?').join(', ')
  const rows = db
    .query<{ assetId: string; id: string; name: string; createdAt: number }, Params>(
      `SELECT at.asset_id AS assetId, t.id, t.name, t.created_at AS createdAt
       FROM asset_tags at
       JOIN tags t ON t.id = at.tag_id
       WHERE at.asset_id IN (${placeholders})
       ORDER BY t.name COLLATE NOCASE ASC, t.id ASC`,
    )
    .all(...assetIds)
  for (const row of rows) {
    const list = map.get(row.assetId) ?? []
    list.push({ id: row.id, name: row.name, createdAt: new Date(row.createdAt).toISOString() })
    map.set(row.assetId, list)
  }
  return map
}
