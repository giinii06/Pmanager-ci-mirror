import type { SQLQueryBindings } from 'bun:sqlite'
import type {
  ActivityDayDTO,
  ActivityItemDTO,
  ActivityStatsDTO,
  VoteActivityDayDTO,
  VoteActivityItemDTO,
  VoteActivityStatsDTO,
} from '@mediavault/shared'
import { newId } from '@mediavault/shared'
import type { Db } from './db'
import type { ContributionEventRecord, VoteEventRecord } from './types'

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

function buildRollingYearCalendar<TItem>(
  byDay: Map<string, TItem[]>,
  now: number,
): {
  days: Array<{ date: string; count: number; level: 0 | 1 | 2 | 3 | 4; items: TItem[] }>
  activeDays: number
  streakDays: number
} {
  const end = new Date(now)
  end.setHours(0, 0, 0, 0)
  const days: Array<{ date: string; count: number; level: 0 | 1 | 2 | 3 | 4; items: TItem[] }> = []
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

  return { days, activeDays, streakDays }
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

  const cal = buildRollingYearCalendar(byDay, now)

  return {
    days: cal.days as ActivityDayDTO[],
    totalCount: rows.length,
    folderContributions,
    videoContributions,
    activeDays: cal.activeDays,
    streakDays: cal.streakDays,
  }
}

export function recordVoteEvent(
  db: Db,
  targetType: 'asset' | 'folder',
  targetId: string,
  title: string,
  now: number,
  id: string = newId(),
): void {
  db.query<null, Params>(
    `INSERT OR IGNORE INTO vote_events (id, target_type, target_id, title, day_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, targetType, targetId, title, formatLocalDayKey(now), now)
}

export function deleteAssetVoteEvents(db: Db, assetId: string): void {
  db.query<null, Params>("DELETE FROM vote_events WHERE target_type = 'asset' AND target_id = ?").run(
    assetId,
  )
}

/**
 * Ensures pre-existing vote counts without matching rows in `vote_events` are
 * represented once without double-counting across restarts or repeat scans.
 */
export function reconcileVoteEvents(db: Db): number {
  const existingCounts = new Map<string, number>()
  const existingRows = db
    .query<{ targetType: string; targetId: string; n: number }, []>(
      'SELECT target_type AS targetType, target_id AS targetId, COUNT(*) AS n FROM vote_events GROUP BY target_type, target_id',
    )
    .all()
  for (const row of existingRows) {
    existingCounts.set(`${row.targetType}:${row.targetId}`, row.n)
  }

  const assetsWithVotes = db
    .query<{ id: string; filename: string; voteCount: number; takenAt: number }, []>(
      'SELECT id, filename, vote_count AS voteCount, taken_at AS takenAt FROM assets WHERE deleted_at IS NULL AND vote_count > 0',
    )
    .all()
  const foldersWithVotes = db
    .query<{ id: string; name: string; voteCount: number; createdAt: number }, []>(
      'SELECT id, name, vote_count AS voteCount, created_at AS createdAt FROM folders WHERE vote_count > 0',
    )
    .all()

  const insert = db.query<null, Params>(
    `INSERT OR IGNORE INTO vote_events (id, target_type, target_id, title, day_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )

  let inserted = 0
  db.transaction(() => {
    for (const asset of assetsWithVotes) {
      const current = existingCounts.get(`asset:${asset.id}`) ?? 0
      const missing = asset.voteCount - current
      if (missing <= 0) continue
      const ts = asset.takenAt > 0 ? asset.takenAt : Date.now()
      const dayKey = formatLocalDayKey(ts)
      for (let idx = current; idx < asset.voteCount; idx += 1) {
        inserted += insert.run(`baseline:asset:${asset.id}:${idx}`, 'asset', asset.id, asset.filename, dayKey, ts).changes
      }
    }
    for (const folder of foldersWithVotes) {
      const current = existingCounts.get(`folder:${folder.id}`) ?? 0
      const missing = folder.voteCount - current
      if (missing <= 0) continue
      const ts = folder.createdAt > 0 ? folder.createdAt : Date.now()
      const dayKey = formatLocalDayKey(ts)
      for (let idx = current; idx < folder.voteCount; idx += 1) {
        inserted += insert.run(`baseline:folder:${folder.id}:${idx}`, 'folder', folder.id, folder.name, dayKey, ts).changes
      }
    }
  })()

  return inserted
}

export function getVoteActivityStats(db: Db, now = Date.now()): VoteActivityStatsDTO {
  reconcileVoteEvents(db)

  const rows = db
    .query<VoteEventRecord, []>(
      `SELECT id, target_type AS targetType, target_id AS targetId, title, day_key AS dayKey, created_at AS createdAt
       FROM vote_events
       ORDER BY created_at ASC, id ASC`,
    )
    .all()

  const byDay = new Map<string, VoteActivityItemDTO[]>()
  let videoVotes = 0
  let folderVotes = 0

  for (const row of rows) {
    if (row.targetType === 'folder') folderVotes += 1
    else videoVotes += 1
    const items = byDay.get(row.dayKey) ?? []
    items.push({
      id: row.id,
      targetType: row.targetType,
      targetId: row.targetId,
      title: row.title,
      createdAt: new Date(row.createdAt).toISOString(),
    })
    byDay.set(row.dayKey, items)
  }

  const cal = buildRollingYearCalendar(byDay, now)

  return {
    days: cal.days as VoteActivityDayDTO[],
    totalVotes: rows.length,
    videoVotes,
    folderVotes,
    activeDays: cal.activeDays,
    streakDays: cal.streakDays,
  }
}
