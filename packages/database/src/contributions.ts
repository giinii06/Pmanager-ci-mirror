import type { SQLQueryBindings } from 'bun:sqlite'
import type { ActivityDayDTO, ActivityItemDTO, ActivityStatsDTO } from '@mediavault/shared'
import type { Db } from './db'
import type { ContributionEventRecord } from './types'

type Params = SQLQueryBindings[]

const DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: process.env.TZ?.trim() || 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function formatLocalDayKey(ms: number): string {
  return DAY_FORMATTER.format(new Date(ms))
}

function pathStem(relativePath: string): string {
  return relativePath.replace(/\.[^./\\]+$/, '')
}

function stableEventId(type: 'folder' | 'video', key: string): string {
  return `${type}:${key}`
}

/**
 * Records initial contributions idempotently for photo folders and standalone videos.
 * Re-scanning or transcoding to another container preserves the original `entity_key`
 * so items are counted at most once on their earliest indexed timestamp.
 */
export function reconcileContributions(db: Db): number {
  const insert = db.query<null, Params>(
    `INSERT OR IGNORE INTO contribution_events (
       id, entity_type, entity_key, asset_id, folder_id, title, relative_path, day_key, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  const photoFolders = db
    .query<
      {
        folderId: string
        libraryId: string
        name: string
        relativePath: string
        firstIndexedAt: number
      },
      []
    >(
      `SELECT f.id AS folderId, f.library_id AS libraryId, f.name, f.relative_path AS relativePath,
              MIN(a.indexed_at) AS firstIndexedAt
       FROM folders f
       JOIN assets a ON a.folder_id = f.id
       WHERE a.deleted_at IS NULL AND a.kind = 'image'
       GROUP BY f.id`,
    )
    .all()

  const standaloneVideos = db
    .query<
      {
        assetId: string
        libraryId: string
        filename: string
        relativePath: string
        indexedAt: number
      },
      []
    >(
      `SELECT a.id AS assetId, a.library_id AS libraryId, a.filename,
              a.relative_path AS relativePath, a.indexed_at AS indexedAt
       FROM assets a
       WHERE a.deleted_at IS NULL AND a.kind = 'video'
         AND (a.folder_id IS NULL OR NOT EXISTS (
           SELECT 1 FROM assets p
           WHERE p.folder_id = a.folder_id AND p.deleted_at IS NULL AND p.kind = 'image'
         ))`,
    )
    .all()

  let inserted = 0
  db.transaction(() => {
    for (const folder of photoFolders) {
      const entityKey = `${folder.libraryId}:folder:${folder.relativePath}`
      const res = insert.run(
        stableEventId('folder', entityKey),
        'folder',
        entityKey,
        null,
        folder.folderId,
        folder.name,
        folder.relativePath,
        formatLocalDayKey(folder.firstIndexedAt),
        folder.firstIndexedAt,
      )
      inserted += res.changes
    }

    for (const video of standaloneVideos) {
      const entityKey = `${video.libraryId}:video:${pathStem(video.relativePath)}`
      const res = insert.run(
        stableEventId('video', entityKey),
        'video',
        entityKey,
        video.assetId,
        null,
        video.filename,
        video.relativePath,
        formatLocalDayKey(video.indexedAt),
        video.indexedAt,
      )
      inserted += res.changes
    }
  })()

  return inserted
}

function levelForCount(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0
  if (count === 1) return 1
  if (count <= 3) return 2
  if (count <= 6) return 3
  return 4
}

export function getActivityStats(db: Db, now = Date.now()): ActivityStatsDTO {
  reconcileContributions(db)

  const rows = db
    .query<ContributionEventRecord, []>(
      `SELECT id, entity_type AS entityType, entity_key AS entityKey,
              asset_id AS assetId, folder_id AS folderId,
              title, relative_path AS relativePath, day_key AS dayKey, occurred_at AS occurredAt
       FROM contribution_events
       ORDER BY occurred_at ASC, id ASC`,
    )
    .all()

  const byDay = new Map<string, ActivityItemDTO[]>()
  let folderContributions = 0
  let videoContributions = 0

  for (const row of rows) {
    if (row.entityType === 'folder') folderContributions += 1
    else videoContributions += 1
    const items = byDay.get(row.dayKey) ?? []
    items.push({
      id: row.id,
      kind: row.entityType,
      name: row.title,
      relativePath: row.relativePath,
      assetId: row.assetId,
      folderId: row.folderId,
    })
    byDay.set(row.dayKey, items)
  }

  const end = new Date(now)
  end.setHours(0, 0, 0, 0)
  const days: ActivityDayDTO[] = []
  let activeDays = 0

  for (let offset = 364; offset >= 0; offset -= 1) {
    const day = new Date(end)
    day.setDate(end.getDate() - offset)
    const key = formatLocalDayKey(day.getTime())
    const items = byDay.get(key) ?? []
    const count = items.length
    if (count > 0) activeDays += 1
    days.push({
      date: key,
      count,
      level: levelForCount(count),
      items,
    })
  }

  let streakDays = 0
  let cursor = days.length - 1
  if (days[cursor]?.count === 0) cursor -= 1
  while (cursor >= 0 && (days[cursor]?.count ?? 0) > 0) {
    streakDays += 1
    cursor -= 1
  }

  return {
    days,
    totalCount: rows.length,
    folderContributions,
    videoContributions,
    activeDays,
    streakDays,
  }
}
