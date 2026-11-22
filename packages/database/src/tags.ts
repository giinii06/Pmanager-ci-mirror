import type { SQLQueryBindings } from 'bun:sqlite'
import type { AssetKind, TagDTO } from '@mediavault/shared'
import type { Db } from './db'
import type { TagRecord, TagSummaryRecord } from './types'

type Params = SQLQueryBindings[]

function tables(kind: AssetKind) {
  return kind === 'image'
    ? { tags: 'photo_tags', links: 'photo_asset_tags' }
    : { tags: 'tags', links: 'asset_tags' }
}

export function listTags(db: Db, kind: AssetKind = 'video'): TagSummaryRecord[] {
  const { tags, links } = tables(kind)
  return db.query<TagSummaryRecord, [AssetKind, AssetKind, AssetKind]>(
    `SELECT t.id, t.name, t.created_at AS createdAt,
       (SELECT COUNT(*) FROM ${links} at JOIN assets a ON a.id = at.asset_id
        WHERE at.tag_id = t.id AND a.deleted_at IS NULL AND a.kind = ?) AS assetCount,
       (SELECT COALESCE(SUM(a.view_count), 0) FROM ${links} at
        JOIN assets a ON a.id = at.asset_id
        WHERE at.tag_id = t.id AND a.deleted_at IS NULL AND a.kind = ?) AS viewCount,
       (SELECT COALESCE(SUM(a.vote_count), 0) FROM ${links} at
        JOIN assets a ON a.id = at.asset_id
        WHERE at.tag_id = t.id AND a.deleted_at IS NULL AND a.kind = ?) AS voteCount,
       cover.id AS coverAssetId, cover.posterVersion AS coverPosterVersion,
       cover.width AS coverWidth, cover.height AS coverHeight
     FROM ${tags} t
     LEFT JOIN (
       SELECT at.tag_id AS tagId, a.id, a.poster_version AS posterVersion,
              a.width, a.height,
              ROW_NUMBER() OVER (PARTITION BY at.tag_id ORDER BY RANDOM()) AS rn
       FROM ${links} at JOIN assets a ON a.id = at.asset_id
       WHERE a.deleted_at IS NULL AND a.kind = '${kind}'
     ) cover ON cover.tagId = t.id AND cover.rn = 1
     ORDER BY t.name COLLATE NOCASE ASC, t.id ASC`,
  ).all(kind, kind, kind)
}

export function getTag(db: Db, id: string, kind: AssetKind = 'video'): TagRecord | null {
  const { tags } = tables(kind)
  return db.query<TagRecord, Params>(
    `SELECT id, name, created_at AS createdAt FROM ${tags} WHERE id = ?`,
  ).get(id) ?? null
}

export function findTagByName(db: Db, name: string, kind: AssetKind = 'video'): TagRecord | null {
  const { tags } = tables(kind)
  return db.query<TagRecord, Params>(
    `SELECT id, name, created_at AS createdAt FROM ${tags} WHERE name = ? COLLATE NOCASE`,
  ).get(name.trim()) ?? null
}

export function createTag(
  db: Db, id: string, rawName: string, now: number, kind: AssetKind = 'video',
): TagRecord {
  const name = rawName.trim()
  if (!name) throw new Error('Tag name cannot be empty')
  const { tags } = tables(kind)
  db.query<null, Params>(`INSERT INTO ${tags} (id, name, created_at) VALUES (?, ?, ?)`)
    .run(id, name, now)
  return { id, name, createdAt: now }
}

export function renameTag(
  db: Db, id: string, rawName: string, kind: AssetKind = 'video',
): TagRecord | null {
  const name = rawName.trim()
  if (!name) throw new Error('Tag name cannot be empty')
  const { tags } = tables(kind)
  const result = db.query<null, Params>(`UPDATE ${tags} SET name = ? WHERE id = ?`).run(name, id)
  return result.changes === 0 ? null : getTag(db, id, kind)
}

export function deleteTag(db: Db, id: string, kind: AssetKind = 'video'): boolean {
  const { tags } = tables(kind)
  return db.query<null, Params>(`DELETE FROM ${tags} WHERE id = ?`).run(id).changes > 0
}

export function addTagToAsset(
  db: Db, assetId: string, tagId: string, now: number, kind: AssetKind = 'video',
): void {
  const { links } = tables(kind)
  db.query<null, Params>(
    `INSERT INTO ${links} (asset_id, tag_id, created_at)
     SELECT ?, ?, ? WHERE EXISTS (
       SELECT 1 FROM assets WHERE id = ? AND kind = ? AND deleted_at IS NULL
     ) ON CONFLICT (asset_id, tag_id) DO NOTHING`,
  ).run(assetId, tagId, now, assetId, kind)
}

export function removeTagFromAsset(
  db: Db, assetId: string, tagId: string, kind: AssetKind = 'video',
): boolean {
  const { links } = tables(kind)
  return db.query<null, Params>(
    `DELETE FROM ${links} WHERE asset_id = ? AND tag_id = ?`,
  ).run(assetId, tagId).changes > 0
}

export function listTagsForAssets(db: Db, assetIds: string[]): Map<string, TagDTO[]> {
  const map = new Map<string, TagDTO[]>()
  if (assetIds.length === 0) return map
  const placeholders = assetIds.map(() => '?').join(', ')
  const rows = db.query<{ assetId: string; id: string; name: string; createdAt: number }, Params>(
    `SELECT links.assetId, links.id, links.name, links.createdAt FROM (
       SELECT at.asset_id AS assetId, t.id, t.name, t.created_at AS createdAt
       FROM asset_tags at JOIN tags t ON t.id = at.tag_id
       JOIN assets a ON a.id = at.asset_id WHERE a.kind = 'video'
       UNION ALL
       SELECT at.asset_id AS assetId, t.id, t.name, t.created_at AS createdAt
       FROM photo_asset_tags at JOIN photo_tags t ON t.id = at.tag_id
       JOIN assets a ON a.id = at.asset_id WHERE a.kind = 'image'
     ) links WHERE links.assetId IN (${placeholders})
     ORDER BY links.name COLLATE NOCASE ASC, links.id ASC`,
  ).all(...assetIds)
  for (const row of rows) {
    const list = map.get(row.assetId) ?? []
    list.push({ id: row.id, name: row.name, createdAt: new Date(row.createdAt).toISOString() })
    map.set(row.assetId, list)
  }
  return map
}
