import {
  getAssetFileInfo,
  getLibrary,
  setScanState,
  type Db,
  type JobRecord,
} from '@mediavault/database'
import {
  ensurePreview,
  generateHls,
  generateImageThumbnails,
  generateVideoThumbnails,
  resolveInside,
} from '@mediavault/media'
import type { WorkerConfig } from './config'
import { withGpuLease } from './gpu'
import { scanLibrary } from './scan'

const HLS_LEASE_WAIT_MS = 5_000
const HLS_LEASE_MS = 120_000

function resolveSource(
  db: Db,
  config: WorkerConfig,
  info: NonNullable<ReturnType<typeof getAssetFileInfo>>,
): string | null {
  const library = getLibrary(db, info.libraryId)
  if (!library) return null
  const root = resolveInside(config.mediaRoot, library.rootPath)
  if (!root) return null
  return resolveInside(root, info.relativePath)
}

export async function executeJob(db: Db, config: WorkerConfig, job: JobRecord): Promise<void> {
  if (job.kind === 'scan_library') {
    if (!job.libraryId) throw new Error('scan job without a library id')
    setScanState(db, job.libraryId, 'scanning')
    try {
      const summary = await scanLibrary(db, config, job.libraryId)
      console.log(
        `[scan] ${job.libraryId} files=${summary.files} added=${summary.added} updated=${summary.updated} removed=${summary.removed} skipped=${summary.skipped}`,
      )
    } catch (error) {
      setScanState(db, job.libraryId, 'idle', (error as Error).message)
      throw error
    }
    return
  }

  if (!job.assetId) throw new Error(`${job.kind} job without an asset id`)
  const info = getAssetFileInfo(db, job.assetId)
  if (!info || info.deletedAt !== null) return

  const source = resolveSource(db, config, info)
  if (!source) throw new Error(`cannot resolve a media path for asset ${info.id}`)

  if (job.kind === 'thumbnail') {
    if (info.kind === 'image') {
      await generateImageThumbnails(source, config.cacheDir, info.id, info.fileVersion)
    } else {
      await generateVideoThumbnails(
        source,
        config.cacheDir,
        info.id,
        info.fileVersion,
        info.durationMs,
      )
    }
    return
  }

  if (job.kind === 'preview') {
    if (info.kind !== 'image') return
    await ensurePreview(source, config.cacheDir, info.id, info.fileVersion)
    return
  }

  if (job.kind === 'hls') {
    const encode = (hwaccel: 'nvenc' | null) =>
      generateHls(source, config.cacheDir, info.id, info.fileVersion, {
        hwaccel,
        width: info.width,
      })

    if (config.hwaccel !== 'nvenc') {
      await encode(config.hwaccel)
      return
    }

    // Playback never waits on a busy card, so a refused lease encodes on the CPU.
    await withGpuLease(
      db,
      {
        resourceId: config.gpuResource,
        owner: config.workerId,
        taskKind: 'hls',
        waitMs: HLS_LEASE_WAIT_MS,
        leaseMs: HLS_LEASE_MS,
      },
      (held) => encode(held ? 'nvenc' : null),
    )
    return
  }

  throw new Error(`unknown job kind: ${job.kind}`)
}
