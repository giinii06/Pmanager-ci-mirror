import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  completeJob,
  enqueueJob,
  getAssetFileInfo,
  getSqliteRuntimeInfo,
  hasActiveJob,
  listLibraries,
  recordRecoveryLog,
  recoverExpiredJobs,
  type Db,
} from '@mediavault/database'
import { fileExists, posterPath, resolveInside, thumbnailPath } from '@mediavault/media'
import { PRIORITY, THUMBNAIL_SIZES, type ThumbnailSize } from '@mediavault/shared'
import type { WorkerConfig } from './config'

const DEFAULT_STALE_TEMP_MS = 2 * 60_000
const THUMBNAIL_RECONCILE_LIMIT = 200

export interface RecoverySummary {
  recoveredJobs: number
  repairedScans: number
  cleanedTempFiles: number
  completedExistingThumbnails: number
  requeuedThumbnails: number
  dbIntegrity: string
}

async function cleanStaleTempFiles(
  rootDir: string,
  cutoffMs: number,
  maxDepth = 4,
  depth = 0,
): Promise<number> {
  if (depth > maxDepth) return 0
  let cleaned = 0
  let entries
  try {
    entries = await readdir(rootDir, { withFileTypes: true })
  } catch {
    return 0
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const abs = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      cleaned += await cleanStaleTempFiles(abs, cutoffMs, maxDepth, depth + 1)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.tmp')) continue
    try {
      const info = await stat(abs)
      if (info.mtimeMs <= cutoffMs) {
        await rm(abs, { force: true })
        cleaned += 1
      }
    } catch {
      // Ignore concurrent deletion.
    }
  }
  return cleaned
}

async function cleanOrphanExtractDirs(
  db: Db,
  config: WorkerConfig,
  cutoffMs: number,
): Promise<number> {
  const activeRunCount =
    db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM jobs WHERE kind = 'process_archive' AND state = 'running'",
      )
      .get()?.n ?? 0
  if (activeRunCount > 0) return 0

  let cleaned = 0
  const walkExtract = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const abs = path.join(dir, entry.name)
      if (entry.name.startsWith('.mv-extract-')) {
        try {
          const info = await stat(abs)
          if (info.mtimeMs <= cutoffMs) {
            await rm(abs, { recursive: true, force: true })
            cleaned += 1
          }
        } catch {
          // Ignore disappeared dir.
        }
        continue
      }
      if (!entry.name.startsWith('.')) await walkExtract(abs, depth + 1)
    }
  }

  for (const lib of listLibraries(db)) {
    const abs = resolveInside(config.mediaRoot, lib.rootPath)
    if (abs) await walkExtract(abs, 0)
  }
  return cleaned
}

async function hasAllThumbnails(
  cacheDir: string,
  asset: { id: string; kind: 'image' | 'video'; fileVersion: number },
): Promise<boolean> {
  for (const size of THUMBNAIL_SIZES as readonly ThumbnailSize[]) {
    const target =
      asset.kind === 'video'
        ? posterPath(cacheDir, asset.id, asset.fileVersion, size)
        : thumbnailPath(cacheDir, asset.id, asset.fileVersion, size)
    if (!(await fileExists(target))) return false
  }
  return true
}

export async function reconcileThumbnails(db: Db, config: WorkerConfig, now: number): Promise<{
  completedExisting: number
  requeuedMissing: number
}> {
  let completedExisting = 0
  const queuedThumbs = db
    .query<{ id: number; assetId: string | null }, [number]>(
      "SELECT id, asset_id AS assetId FROM jobs WHERE kind = 'thumbnail' AND state = 'queued' LIMIT ?",
    )
    .all(THUMBNAIL_RECONCILE_LIMIT)

  for (const row of queuedThumbs) {
    if (!row.assetId) continue
    const info = getAssetFileInfo(db, row.assetId)
    if (!info || info.deletedAt !== null) continue
    if (await hasAllThumbnails(config.cacheDir, info)) {
      db.query<null, [number, number, number]>(
        "UPDATE jobs SET state = 'done', phase = 'reconciled', completed_at = ?, updated_at = ? WHERE id = ? AND state = 'queued'",
      ).run(now, now, row.id)
      completedExisting += 1
    }
  }

  let requeuedMissing = 0
  const recentAssets = db
    .query<{ id: string; kind: 'image' | 'video'; fileVersion: number }, [number]>(
      `SELECT id, kind, file_version AS fileVersion
       FROM assets
       WHERE deleted_at IS NULL
       ORDER BY indexed_at DESC
       LIMIT ?`,
    )
    .all(THUMBNAIL_RECONCILE_LIMIT)

  for (const asset of recentAssets) {
    const key = `thumbnail:${asset.id}:${asset.fileVersion}`
    if (hasActiveJob(db, key)) continue
    if (await hasAllThumbnails(config.cacheDir, asset)) continue
    enqueueJob(
      db,
      {
        dedupeKey: key,
        kind: 'thumbnail',
        priority: PRIORITY.backlog,
        assetId: asset.id,
      },
      now,
    )
    requeuedMissing += 1
  }

  return { completedExisting, requeuedMissing }
}

function repairInterruptedLibraryScans(db: Db, now: number): number {
  let repaired = 0
  for (const lib of listLibraries(db)) {
    if (lib.scanState === 'idle') continue
    const active = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM jobs WHERE kind = 'scan_library' AND library_id = ? AND state IN ('queued','running','paused')",
      )
      .get(lib.id)?.n
    if (!active || active === 0) {
      enqueueJob(
        db,
        {
          dedupeKey: `scan:${lib.id}`,
          kind: 'scan_library',
          priority: PRIORITY.next,
          libraryId: lib.id,
        },
        now,
      )
      repaired += 1
    }
  }
  return repaired
}

export async function runWorkerRecovery(
  db: Db,
  config: WorkerConfig,
  options: { now?: number; recordLog?: boolean; reconcileThumbs?: boolean } = {},
): Promise<RecoverySummary> {
  const now = options.now ?? Date.now()
  const staleAgeMs = config.staleTempAgeMs ?? DEFAULT_STALE_TEMP_MS
  const cutoffMs = now - staleAgeMs
  const dbIntegrity = getSqliteRuntimeInfo(db).integrity
  const recoveredJobs = recoverExpiredJobs(db, now)
  db.query<null, [number, number]>(
    `UPDATE scan_runs SET
       phase = 'failed',
       status = 'failed',
       error_message = COALESCE(error_message, 'interrupted by worker restart'),
       completed_at = COALESCE(completed_at, ?),
       updated_at = ?
     WHERE status = 'running'
       AND library_id NOT IN (
         SELECT library_id FROM jobs WHERE kind = 'scan_library' AND state = 'running' AND library_id IS NOT NULL
       )`,
  ).run(now, now)
  const repairedScans = repairInterruptedLibraryScans(db, now)
  const cleanedTemp =
    (await cleanStaleTempFiles(config.cacheDir, cutoffMs)) +
    (await cleanOrphanExtractDirs(db, config, cutoffMs))

  const thumbs = options.reconcileThumbs
    ? await reconcileThumbnails(db, config, now)
    : { completedExisting: 0, requeuedMissing: 0 }

  if (options.recordLog !== false) {
    recordRecoveryLog(db, {
      workerId: config.workerId,
      recoveredJobs: recoveredJobs + repairedScans,
      cleanedTempFiles: cleanedTemp,
      requeuedThumbnails: thumbs.requeuedMissing,
      dbIntegrity,
      createdAt: now,
    })
  }

  return {
    recoveredJobs,
    repairedScans,
    cleanedTempFiles: cleanedTemp,
    completedExistingThumbnails: thumbs.completedExisting,
    requeuedThumbnails: thumbs.requeuedMissing,
    dbIntegrity,
  }
}

export { completeJob }
