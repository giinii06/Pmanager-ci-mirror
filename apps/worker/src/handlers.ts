import path from 'node:path'
import {
  getAssetFileInfo,
  getLibrary,
  setScanState,
  updateArchiveJob,
  type Db,
  type JobRecord,
} from '@mediavault/database'
import {
  ensurePreview,
  extractAndProcessArchive,
  generateHls,
  generateImageThumbnails,
  generateVideoThumbnails,
  resolveInside,
  waitForArchiveStability,
} from '@mediavault/media'
import type { WorkerConfig } from './config'
import { withGpuLease } from './gpu'
import { scanLibrary } from './scan'

const HLS_LEASE_WAIT_MS = 5_000
const HLS_LEASE_MS = 120_000
const TRANSCODE_LEASE_MS = 600_000

interface ArchiveJobPayload {
  archiveJobId: string
  libraryId: string
  primaryPath: string
  volumes: string[]
}

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

function safeResolveVolumes(
  db: Db,
  config: WorkerConfig,
  payload: ArchiveJobPayload,
): { primaryPath: string; volumes: string[] } {
  const library = getLibrary(db, payload.libraryId)
  if (!library) throw new Error(`library ${payload.libraryId} no longer exists`)
  const libRoot = resolveInside(config.mediaRoot, library.rootPath)
  if (!libRoot) throw new Error(`library root escapes MEDIA_ROOT: ${library.rootPath}`)

  const volumes = payload.volumes.map((volume) => {
    const rel = path.relative(libRoot, volume)
    const checked = resolveInside(libRoot, rel)
    if (!checked) throw new Error(`archive volume escapes library root: ${volume}`)
    return checked
  })
  const primaryRel = path.relative(libRoot, payload.primaryPath)
  const primaryPath = resolveInside(libRoot, primaryRel)
  if (!primaryPath) throw new Error(`archive path escapes library root: ${payload.primaryPath}`)
  return { primaryPath, volumes }
}

async function runArchiveJob(db: Db, config: WorkerConfig, job: JobRecord): Promise<void> {
  if (!job.payload) throw new Error('process_archive job missing payload')
  const payload = JSON.parse(job.payload) as ArchiveJobPayload
  const { primaryPath, volumes } = safeResolveVolumes(db, config, payload)

  try {
    await waitForArchiveStability(volumes, {
      stableMs: config.archiveStableMs ?? 1_500,
      timeoutMs: config.archiveTimeoutMs ?? 15 * 60_000,
    })

    const result = await extractAndProcessArchive({
      primaryPath,
      volumes,
      hwaccel: config.hwaccel,
      onPhase: (phase) => {
        updateArchiveJob(db, payload.archiveJobId, { state: phase }, Date.now())
      },
      withVideoGpuLease:
        config.hwaccel === 'nvenc'
          ? (fn) =>
              withGpuLease(
                db,
                {
                  resourceId: config.gpuResource,
                  owner: config.workerId,
                  taskKind: 'transcode',
                  waitMs: HLS_LEASE_WAIT_MS,
                  leaseMs: TRANSCODE_LEASE_MS,
                },
                (held, signal) => fn(held ? 'nvenc' : null, signal),
              )
          : undefined,
    })

    if (result.status === 'failed_password') {
      updateArchiveJob(
        db,
        payload.archiveJobId,
        { state: 'failed_password', errorMessage: result.errorMessage },
        Date.now(),
      )
      console.warn(`[archive] wrong password for ${payload.primaryPath}; preserved original RAR`)
      return
    }

    updateArchiveJob(
      db,
      payload.archiveJobId,
      {
        state: 'completed',
        passwordUsed: result.passwordUsed,
        extractedFiles: result.extractedFiles,
        convertedImages: result.convertedImages,
        convertedVideos: result.convertedVideos,
        errorMessage: null,
      },
      Date.now(),
    )
    await scanLibrary(db, config, payload.libraryId)
  } catch (error) {
    updateArchiveJob(
      db,
      payload.archiveJobId,
      { state: 'failed', errorMessage: (error as Error).message.slice(0, 500) },
      Date.now(),
    )
    throw error
  }
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

  if (job.kind === 'process_archive') {
    await runArchiveJob(db, config, job)
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
    const encode = (hwaccel: 'nvenc' | null, signal?: AbortSignal) =>
      generateHls(source, config.cacheDir, info.id, info.fileVersion, {
        hwaccel,
        width: info.width,
        signal,
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
      (held, signal) => encode(held ? 'nvenc' : null, signal),
    )
    return
  }

  throw new Error(`unknown job kind: ${job.kind}`)
}
