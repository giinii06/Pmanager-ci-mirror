import { stat, statfs } from 'node:fs/promises'
import path from 'node:path'
import {
  countNotifications,
  getGpuLease,
  getLatestBackupLog,
  getSqliteRuntimeInfo,
  jobCounts,
  listActiveWorkerLeases,
  listBackupLogs,
  listWorkerHeartbeats,
  recentFailures,
  workQueue,
} from '@mediavault/database'
import {
  APP_VERSION,
  type DiagnosticsReportDTO,
  type GpuLeaseHealthDTO,
  type StorageCategoryDTO,
  type VolumeHealthDTO,
} from '@mediavault/shared'
import { BOOT_AT_ISO, uptimeSeconds } from './boot'
import { scanCache } from './cache-inventory'
import type { AppContext } from './context'
import { toJobDTO, toWorkQueueDTO, toWorkerHeartbeatDTO } from './dto'
import { checkLibraryHealth } from './library-health'
import { readSearchIndexStatus, toSearchIndexStatusDTO } from './search-index'
import { sqliteIntegrity } from './sqlite-health'
import { measureTree } from './tree-size'

const BACKUP_TOTAL_LIMIT = 500

function roots(ctx: AppContext): Array<[string, string]> {
  return [
    [ctx.config.mediaRoot, '<media>'],
    [ctx.config.cacheDir, '<cache>'],
    [ctx.config.dataDir, '<data>'],
    [ctx.config.asr.resultDir, '<ai>'],
    [ctx.config.translation.resultDir, '<ai>'],
  ]
}

/**
 * A report may be pasted into a chat, so every absolute root becomes a token.
 * Longest first so a nested root is not half-replaced by its parent.
 */
export function redactText(text: string, ctx: AppContext): string {
  let result = text
  for (const [root, label] of roots(ctx).sort(([a], [b]) => b.length - a.length)) {
    if (root.length <= 1) continue
    result = result.split(root).join(label)
  }
  return result
}

async function volume(label: string, root: string): Promise<VolumeHealthDTO> {
  try {
    const info = await statfs(root)
    const totalBytes = info.bsize * info.blocks
    const freeBytes = info.bsize * info.bavail
    return {
      label,
      totalBytes,
      freeBytes,
      freeRatio: totalBytes > 0 ? freeBytes / totalBytes : null,
      stale: false,
    }
  } catch {
    return { label, totalBytes: null, freeBytes: null, freeRatio: null, stale: true }
  }
}

async function buildStorage(
  ctx: AppContext,
  cacheTypes: Array<{ type: string; bytes: number; files: number }>,
): Promise<{ volumes: VolumeHealthDTO[]; categories: StorageCategoryDTO[] }> {
  const volumes = await Promise.all([
    volume('media', ctx.config.mediaRoot),
    volume('cache', ctx.config.cacheDir),
    volume('data', ctx.config.dataDir),
  ])

  const library = ctx.db
    .query<{ bytes: number; files: number }, []>(
      `SELECT COALESCE(SUM(size_bytes), 0) AS bytes, COUNT(*) AS files
       FROM assets WHERE deleted_at IS NULL`,
    )
    .get() ?? { bytes: 0, files: 0 }

  const categories: StorageCategoryDTO[] = [
    { type: 'library', bytes: library.bytes, files: library.files },
    ...cacheTypes.map((type) => ({ type: type.type, bytes: type.bytes, files: type.files })),
  ]

  const [backups, logs] = await Promise.all([
    measureTree(path.join(ctx.config.dataDir, 'backups')),
    measureTree(path.join(ctx.config.dataDir, 'logs')),
  ])
  categories.push({ type: 'backups', bytes: backups.bytes, files: backups.files })
  categories.push({ type: 'logs', bytes: logs.bytes, files: logs.files })

  let quarantineBytes = 0
  let quarantineFiles = 0
  const libs = ctx.db
    .query<{ rootPath: string }, []>('SELECT root_path AS rootPath FROM libraries')
    .all()
  for (const lib of libs) {
    const measured = await measureTree(
      path.join(ctx.config.mediaRoot, lib.rootPath, '.mediavault-quarantine'),
    )
    quarantineBytes += measured.bytes
    quarantineFiles += measured.files
  }
  categories.push({ type: 'quarantine', bytes: quarantineBytes, files: quarantineFiles })

  return { volumes, categories }
}

export async function buildDiagnosticsReport(ctx: AppContext): Promise<DiagnosticsReportDTO> {
  const now = Date.now()
  const dbPath = path.join(ctx.config.dataDir, 'mediavault.db')
  const [dbBytes, walBytes] = await Promise.all([
    stat(dbPath).then((info) => info.size).catch(() => 0),
    stat(`${dbPath}-wal`).then((info) => info.size).catch(() => 0),
  ])

  const journal = ctx.db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()
  const pages = ctx.db.query<{ page_count: number }, []>('PRAGMA page_count').get()
  const freelist = ctx.db.query<{ freelist_count: number }, []>('PRAGMA freelist_count').get()
  const busy = ctx.db.query<{ timeout: number }, []>('PRAGMA busy_timeout').get()
  const schema = ctx.db.query<{ user_version: number }, []>('PRAGMA user_version').get()
  const sqlite = getSqliteRuntimeInfo(ctx.db, { checkIntegrity: false })

  const libraries = await checkLibraryHealth(ctx)
  const heartbeats = listWorkerHeartbeats(ctx.db).map(toWorkerHeartbeatDTO)
  const leases = listActiveWorkerLeases(ctx.db, now)
  const gpuLease = getGpuLease(ctx.db, ctx.config.gpu.resourceId)
  const gpuLeases: GpuLeaseHealthDTO[] = gpuLease
    ? [
        {
          resourceId: gpuLease.resourceId,
          owner: gpuLease.owner,
          taskKind: gpuLease.taskKind,
          leaseExpiresAt: new Date(gpuLease.leaseExpiresAt).toISOString(),
          updatedAt: new Date(gpuLease.updatedAt).toISOString(),
          expired: gpuLease.leaseExpiresAt <= now,
        },
      ]
    : []

  const failures = recentFailures(ctx.db).map((job) => {
    const dto = toJobDTO(job)
    return { ...dto, lastError: dto.lastError ? redactText(dto.lastError, ctx) : null }
  })

  const queue = workQueue(ctx.db, now, ctx.config.gpu.resourceId, {
    maxSceneWindows: ctx.config.scene.maxWindows,
  })
  const queueDto = toWorkQueueDTO(queue)

  const backupLogs = listBackupLogs(ctx.db, BACKUP_TOTAL_LIMIT)
  const latestBackup = getLatestBackupLog(ctx.db)
  const lastSuccess = getLatestBackupLog(ctx.db, true)
  const cache = await scanCache(ctx)
  const notificationCounts = countNotifications(ctx.db, now)

  const storage = await buildStorage(ctx, cache.inventory.types)

  return {
    generatedAt: new Date(now).toISOString(),
    app: {
      version: APP_VERSION,
      startedAt: BOOT_AT_ISO,
      uptimeSeconds: uptimeSeconds(now),
      pid: process.pid,
      bunVersion: process.versions.bun ?? 'unknown',
    },
    database: {
      schemaVersion: schema?.user_version ?? 0,
      integrity: sqliteIntegrity(ctx, now),
      sqliteVersion: sqlite.sqliteVersion,
      synchronousMode: sqlite.synchronousMode,
      journalMode: journal?.journal_mode ?? 'unknown',
      dbBytes,
      walBytes,
      pageCount: pages?.page_count ?? 0,
      freelistCount: freelist?.freelist_count ?? 0,
      busyTimeoutMs: busy?.timeout ?? 0,
    },
    libraries: libraries.map((library) => ({
      ...library,
      lastError: library.lastError ? redactText(library.lastError, ctx) : null,
    })),
    workers: {
      heartbeats,
      activeLeases: leases.map((lease) => ({
        workerId: lease.workerId,
        jobId: lease.jobId,
        kind: lease.kind,
        phase: lease.phase,
        progressCurrent: lease.progressCurrent,
        progressTotal: lease.progressTotal,
        leaseExpiresAt:
          lease.leaseExpiresAt !== null ? new Date(lease.leaseExpiresAt).toISOString() : null,
      })),
      gpuLeases,
      recentFailures: failures,
    },
    queues: {
      counts: jobCounts(ctx.db),
      pipelines: queueDto.pipelines,
      stalled: queue.stalled.length,
      remaining: queue.remaining,
    },
    backups: {
      latest: latestBackup
        ? {
            id: latestBackup.id,
            filename: latestBackup.filename,
            sizeBytes: latestBackup.sizeBytes,
            integrity: latestBackup.integrity,
            createdAt: new Date(latestBackup.createdAt).toISOString(),
            error: latestBackup.error,
          }
        : null,
      lastSuccessAt: lastSuccess ? new Date(lastSuccess.createdAt).toISOString() : null,
      lastSuccessAgeHours:
        lastSuccess !== null ? Math.round((now - lastSuccess.createdAt) / 3_600_000) : null,
      count: backupLogs.length,
      totalBytes: backupLogs.reduce((sum, row) => sum + row.sizeBytes, 0),
      externalCopy: 'unknown',
    },
    storage,
    caches: cache.inventory,
    searchIndex: toSearchIndexStatusDTO(readSearchIndexStatus(ctx)),
    notifications: notificationCounts,
    flags: {
      fileMutation: ctx.config.fileMutationEnabled,
      hlsGenerations: ctx.config.hlsGenerationsEnabled,
      bulkOperations: ctx.config.bulkOperationsEnabled === true,
      notifications: ctx.config.notificationsEnabled === true,
      searchFts: ctx.config.search.ftsEnabled,
    },
  }
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '-'
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

function ageHours(from: string | null, now: string): number | null {
  if (from === null) return null
  return Math.round((Date.parse(now) - Date.parse(from)) / 3_600_000)
}

/** What search is serving, and why it is serving it. */
function searchIndexSection(report: DiagnosticsReportDTO): string[] {
  const index = report.searchIndex
  const active = index.active
  const live = index.live
  return [
    '## Search index',
    '',
    ...table(
      ['field', 'value'],
      [
        ['mode', index.mode],
        ['state', active?.state ?? 'none'],
        ['build', active === null ? '-' : shortId(active.id)],
        ['source', active?.source ?? '-'],
        ['verifiedAgeHours', ageHours(active?.verifiedAt ?? null, report.generatedAt)],
        [
          'documents',
          live === null ? '-' : `${live.assets} assets / ${live.segments} segments`,
        ],
        [
          'watermark',
          live === null ? '-' : `${live.assetWatermark} / ${live.segmentWatermark}`,
        ],
        [
          'rowsSinceBuild',
          index.rowsSinceBuild === null
            ? '-'
            : `${index.rowsSinceBuild.assets} assets / ${index.rowsSinceBuild.segments} segments`,
        ],
        ['triggersArmed', index.triggersArmed],
        ['processReady', index.processReady],
        ['intact', index.intact],
        ['fallback', index.fallback],
        ['lastError', active?.lastError],
      ],
    ),
    '',
    ...table(
      ['build', 'state', 'source', 'startedAt', 'assets', 'segments', 'lastError'],
      index.recent.map((build) => [
        shortId(build.id),
        build.state,
        build.source,
        build.startedAt,
        build.assets,
        build.segments,
        build.lastError,
      ]),
    ),
  ]
}

function table(headers: string[], rows: unknown[][]): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ]
}

/** Deterministic Markdown: the same report renders byte-identical. */
export function renderDiagnosticsMarkdown(report: DiagnosticsReportDTO): string {
  const lines: string[] = [
    '# MediaVault diagnostics',
    '',
    `generated: ${report.generatedAt}`,
    '',
    '## App',
    '',
    ...table(
      ['field', 'value'],
      [
        ['version', report.app.version],
        ['startedAt', report.app.startedAt],
        ['uptimeSeconds', report.app.uptimeSeconds],
        ['pid', report.app.pid],
        ['bunVersion', report.app.bunVersion],
      ],
    ),
    '',
    '## Database',
    '',
    ...table(
      ['field', 'value'],
      [
        ['schemaVersion', report.database.schemaVersion],
        ['integrity', report.database.integrity],
        ['sqliteVersion', report.database.sqliteVersion],
        ['synchronousMode', report.database.synchronousMode],
        ['journalMode', report.database.journalMode],
        ['dbBytes', report.database.dbBytes],
        ['walBytes', report.database.walBytes],
        ['pageCount', report.database.pageCount],
        ['freelistCount', report.database.freelistCount],
        ['busyTimeoutMs', report.database.busyTimeoutMs],
      ],
    ),
    '',
    '## Libraries',
    '',
    ...table(
      ['name', 'root', 'status', 'scanState', 'assets', 'lastError'],
      report.libraries.map((library) => [
        library.name,
        library.rootPath === '' ? '<media>' : library.rootPath,
        library.status,
        library.scanState,
        library.assetCount,
        library.lastError,
      ]),
    ),
    '',
    '## Workers',
    '',
    ...table(
      ['workerId', 'component', 'state', 'pid', 'currentJobId', 'lastSeenAt'],
      report.workers.heartbeats.map((beat) => [
        beat.workerId,
        beat.component,
        beat.state,
        beat.pid,
        beat.currentJobId,
        beat.lastSeenAt,
      ]),
    ),
    '',
    ...table(
      ['workerId', 'jobId', 'kind', 'phase', 'progress', 'leaseExpiresAt'],
      report.workers.activeLeases.map((lease) => [
        lease.workerId,
        lease.jobId,
        lease.kind,
        lease.phase,
        `${lease.progressCurrent}/${lease.progressTotal ?? '?'}`,
        lease.leaseExpiresAt,
      ]),
    ),
    '',
    ...table(
      ['resourceId', 'owner', 'taskKind', 'expires', 'expired'],
      report.workers.gpuLeases.map((lease) => [
        lease.resourceId,
        lease.owner,
        lease.taskKind,
        lease.leaseExpiresAt,
        lease.expired,
      ]),
    ),
    '',
    ...table(
      ['jobId', 'kind', 'attempts', 'requestId', 'lastError'],
      report.workers.recentFailures.map((job) => [
        job.id,
        job.kind,
        `${job.attempts}/${job.maxAttempts}`,
        job.requestId ?? '-',
        job.lastError,
      ]),
    ),
    '',
    '## Queues',
    '',
    ...table(
      ['state', 'count'],
      Object.entries(report.queues.counts).map(([state, count]) => [state, count]),
    ),
    '',
    ...table(
      ['pipeline', 'running', 'queued', 'stalled', 'etaSeconds'],
      report.queues.pipelines.map((pipeline) => [
        pipeline.pipeline,
        pipeline.running,
        pipeline.queued,
        pipeline.stalled,
        pipeline.etaSeconds,
      ]),
    ),
    '',
    `stalled: ${report.queues.stalled}`,
    `remaining: ${report.queues.remaining}`,
    '',
    '## Backups',
    '',
    ...table(
      ['field', 'value'],
      [
        ['latest', report.backups.latest?.filename ?? 'none'],
        ['latestIntegrity', report.backups.latest?.integrity ?? '-'],
        ['lastSuccessAt', report.backups.lastSuccessAt],
        ['lastSuccessAgeHours', report.backups.lastSuccessAgeHours],
        ['count', report.backups.count],
        ['totalBytes', report.backups.totalBytes],
        ['externalCopy', report.backups.externalCopy],
      ],
    ),
    '',
    '## Storage',
    '',
    ...table(
      ['volume', 'totalBytes', 'freeBytes', 'freeRatio', 'stale'],
      report.storage.volumes.map((volume) => [
        volume.label,
        volume.totalBytes,
        volume.freeBytes,
        volume.freeRatio === null ? '-' : volume.freeRatio.toFixed(3),
        volume.stale,
      ]),
    ),
    '',
    ...table(
      ['category', 'bytes', 'files'],
      report.storage.categories.map((category) => [
        category.type,
        category.bytes,
        category.files,
      ]),
    ),
    '',
    '## Caches',
    '',
    ...table(
      ['type', 'bytes', 'files', 'oldestAt', 'newestAt', 'regenerable', 'protected'],
      report.caches.types.map((type) => [
        type.type,
        type.bytes,
        type.files,
        type.oldestAt,
        type.newestAt,
        type.regenerable,
        type.protected,
      ]),
    ),
    '',
    `totalBytes: ${report.caches.totalBytes}`,
    '',
    ...searchIndexSection(report),
    '',
    '## Notifications',
    '',
    ...table(
      ['open', 'unread', 'last24h'],
      [[report.notifications.open, report.notifications.unread, report.notifications.last24h]],
    ),
    '',
    '## Flags',
    '',
    ...table(
      ['flag', 'enabled'],
      Object.entries(report.flags),
    ),
    '',
  ]
  return lines.join('\n')
}
