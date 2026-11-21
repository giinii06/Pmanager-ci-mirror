import { rm } from 'node:fs/promises'
import path from 'node:path'
import { newId } from '@mediavault/shared'
import {
  HLS_GC_GRACE_MS,
  claimHlsGeneration,
  failHlsGeneration,
  getArchiveJob,
  getAssetFileInfo,
  getHlsGeneration,
  getJob,
  getLibrary,
  isHlsJobLeaseLive,
  publishHlsGeneration,
  setScanState,
  updateArchiveJob,
  updateHlsProgress,
  type Db,
  type HlsJobFence,
  type JobRecord,
} from '@mediavault/database'
import {
  HlsAbortedError,
  ensurePreview,
  extractAndProcessArchive,
  generateHls,
  generateHlsGeneration,
  generateImageThumbnails,
  generateVideoThumbnails,
  resolveInside,
  waitForArchiveStability,
} from '@mediavault/media'
import type { WorkerConfig } from './config'
import { scanDuplicates } from './duplicates/scan'
import { queueExactDuplicateCleanup } from './duplicates/auto-cleanup'
import { withGpuLease } from './gpu'
import { ScanInterruptedError, interruptionReason, scanLibrary, type ScanFenceContext } from './scan'

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const reason = interruptionReason(signal)
  throw new ScanInterruptedError(reason, `job interrupted (${reason})`)
}

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

async function runArchiveJob(
  db: Db,
  config: WorkerConfig,
  job: JobRecord,
  signal?: AbortSignal,
): Promise<void> {
  if (!job.payload) throw new Error('process_archive job missing payload')
  throwIfAborted(signal)
  const payload = JSON.parse(job.payload) as ArchiveJobPayload
  if (getArchiveJob(db, payload.archiveJobId)?.state === 'completed') return
  const { primaryPath, volumes } = safeResolveVolumes(db, config, payload)

  let completedArchive = false
  try {
    await waitForArchiveStability(volumes, {
      stableMs: config.archiveStableMs ?? 1_500,
      timeoutMs: config.archiveTimeoutMs ?? 15 * 60_000,
    })
    throwIfAborted(signal)

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
                (held, leaseSignal) => fn(held ? 'nvenc' : null, leaseSignal),
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
    completedArchive = true
  } catch (error) {
    throwIfAborted(signal)
    updateArchiveJob(
      db,
      payload.archiveJobId,
      { state: 'failed', errorMessage: (error as Error).message.slice(0, 500) },
      Date.now(),
    )
    throw error
  }
  if (completedArchive) {
    throwIfAborted(signal)
    await scanLibrary(db, config, payload.libraryId, { signal })
  }
}

function classifyHlsError(message: string): string {
  if (/lease was lost/.test(message)) return 'gpu_lease_lost'
  if (/MPEG-TS|playlist|segment/i.test(message)) return 'validation_failed'
  if (/nvenc/i.test(message)) return 'nvenc_failed'
  return 'encode_failed'
}

/**
 * Encodes one immutable generation. The attempt directory is unique, so a
 * worker that loses its lease can only delete its own output; the publish
 * transaction decides which attempt becomes the active generation.
 */
async function runHlsGeneration(
  db: Db,
  config: WorkerConfig,
  job: JobRecord,
  info: NonNullable<ReturnType<typeof getAssetFileInfo>>,
  source: string,
  generationId: string,
  execCtx: ExecuteJobContext,
): Promise<void> {
  const generation = getHlsGeneration(db, generationId)
  if (!generation) throw new Error(`hls generation ${generationId} does not exist`)
  if (generation.assetId !== info.id) throw new Error('hls generation belongs to another asset')
  if (generation.state === 'ready') return
  if (generation.fileVersion !== info.fileVersion) {
    throw new Error(
      `hls generation is for version ${generation.fileVersion}, the asset is ${info.fileVersion}`,
    )
  }

  const fence: HlsJobFence = {
    workerId: execCtx.fence?.workerId ?? job.workerId ?? config.workerId,
    leaseEpoch: execCtx.fence?.leaseEpoch ?? job.leaseEpoch,
    jobId: job.id,
    now: Date.now(),
  }
  if (!claimHlsGeneration(db, generationId, fence)) {
    throwIfAborted(execCtx.signal)
    if (getHlsGeneration(db, generationId)?.state === 'ready') return
    throw new Error(`hls generation ${generationId} could not be claimed`)
  }

  let lastProgressWrite = 0
  const onProgress = (percent: number) => {
    const now = Date.now()
    if (now - lastProgressWrite < 10_000) return
    lastProgressWrite = now
    fence.now = now
    updateHlsProgress(db, generationId, fence, percent, 'encoding')
  }
  const canPublish = () => {
    fence.now = Date.now()
    return isHlsJobLeaseLive(db, fence)
  }

  const encode = (hwaccel: 'nvenc' | null, leaseSignal?: AbortSignal) => {
    const combined =
      leaseSignal && execCtx.signal
        ? AbortSignal.any([execCtx.signal, leaseSignal])
        : (execCtx.signal ?? leaseSignal)
    return generateHlsGeneration(source, config.cacheDir, {
      assetId: info.id,
      fileVersion: info.fileVersion,
      generationId,
      attemptId: newId(),
      hwaccel,
      width: info.width,
      durationMs: info.durationMs,
      signal: combined,
      onProgress,
      canPublish,
    })
  }

  try {
    const result =
      config.hwaccel !== 'nvenc'
        ? await encode(config.hwaccel)
        : await withGpuLease(
            db,
            {
              resourceId: config.gpuResource,
              owner: config.workerId,
              taskKind: 'hls',
              waitMs: HLS_LEASE_WAIT_MS,
              leaseMs: HLS_LEASE_MS,
            },
            (held, leaseSignal) => encode(held ? 'nvenc' : null, leaseSignal),
          )

    if (!result) return
    fence.now = Date.now()
    const published = publishHlsGeneration(db, {
      id: generationId,
      fence,
      storageRel: result.storageRel,
      playlistRel: result.playlistRel,
      encoder: result.encoder,
      graceMs: HLS_GC_GRACE_MS,
    })
    if (!published.published) {
      const dir = resolveInside(config.cacheDir, result.storageRel)
      if (dir) await rm(dir, { recursive: true, force: true })
      throw new Error('hls publication was refused by the lease or the asset state')
    }
  } catch (error) {
    fence.now = Date.now()
    if (error instanceof HlsAbortedError || execCtx.signal?.aborted) {
      const reason = execCtx.signal?.reason
      failHlsGeneration(db, generationId, fence, {
        state: reason === 'cancelled' ? 'cancelled' : 'retry_wait',
        errorCode: String(reason ?? 'aborted'),
        errorMessage: 'the encode was interrupted',
      })
      throwIfAborted(execCtx.signal)
      throw error
    }
    const message = (error as Error).message
    failHlsGeneration(db, generationId, fence, {
      state: job.attempts >= job.maxAttempts ? 'failed' : 'retry_wait',
      errorCode: classifyHlsError(message),
      errorMessage: message,
    })
    throw error
  }
}

export interface ExecuteJobContext {
  signal?: AbortSignal
  fence?: ScanFenceContext
}

export async function executeJob(
  db: Db,
  config: WorkerConfig,
  job: JobRecord,
  execCtx: ExecuteJobContext = {},
): Promise<void> {
  if (job.kind === 'scan_library') {
    if (!job.libraryId) throw new Error('scan job without a library id')
    setScanState(db, job.libraryId, 'scanning')
    try {
      const summary = await scanLibrary(db, config, job.libraryId, {
        fence: execCtx.fence,
        signal: execCtx.signal,
      })
      console.log(
        `[scan] ${job.libraryId} files=${summary.files} added=${summary.added} updated=${summary.updated} removed=${summary.removed} skipped=${summary.skipped}`,
      )
    } catch (error) {
      if (!(error instanceof ScanInterruptedError && error.reason === 'lease_lost')) {
        setScanState(db, job.libraryId, 'idle', (error as Error).message)
      }
      throw error
    }
    return
  }

  if (job.kind === 'process_archive') {
    await runArchiveJob(db, config, job, execCtx.signal)
    return
  }

  if (job.kind === 'maintenance') {
    const payload = job.payload ? (JSON.parse(job.payload) as { task?: string }) : {}
    if (payload.task !== 'duplicates') throw new Error('unknown maintenance task')
    throwIfAborted(execCtx.signal)
    const summary = await scanDuplicates(db, config, {
      libraryId: job.libraryId ?? undefined,
      signal: execCtx.signal,
    })
    console.log(
      `[duplicates] candidates=${summary.candidates} hashed=${summary.hashed} reused=${summary.reused} groups=${summary.groups} members=${summary.members} hardlinked=${summary.hardlinked}`,
    )
    // Scoped scans are not a complete view of the user's library; only a full,
    // uninterrupted scan may schedule destructive cleanup.
    if (config.fileMutationEnabled && !job.libraryId && !execCtx.signal?.aborted) {
      const cleanup = queueExactDuplicateCleanup(db)
      console.log(`[duplicates] automatic cleanup queued=${cleanup.queued} skipped=${cleanup.skipped}`)
    }
    return
  }

  throwIfAborted(execCtx.signal)
  if (!job.assetId) throw new Error(`${job.kind} job without an asset id`)
  const info = getAssetFileInfo(db, job.assetId)
  if (!info || info.deletedAt !== null) return

  const source = resolveSource(db, config, info)
  if (!source) throw new Error(`cannot resolve a media path for asset ${info.id}`)

  if (job.kind === 'thumbnail') {
    const canPublish = () => {
      if (execCtx.signal?.aborted) return false
      const freshAsset = getAssetFileInfo(db, info.id)
      if (!freshAsset || freshAsset.deletedAt !== null || freshAsset.fileVersion !== info.fileVersion) {
        return false
      }
      if (execCtx.fence) {
        const liveJob = getJob(db, job.id)
        if (
          !liveJob ||
          liveJob.state !== 'running' ||
          liveJob.workerId !== execCtx.fence.workerId ||
          liveJob.leaseEpoch !== execCtx.fence.leaseEpoch
        ) {
          return false
        }
      }
      return true
    }

    if (info.kind === 'image') {
      await generateImageThumbnails(source, config.cacheDir, info.id, info.fileVersion, {
        canPublish,
      })
    } else {
      await generateVideoThumbnails(
        source,
        config.cacheDir,
        info.id,
        info.fileVersion,
        info.durationMs,
        { canPublish },
      )
    }
    throwIfAborted(execCtx.signal)
    return
  }

  if (job.kind === 'preview') {
    if (info.kind !== 'image') return
    await ensurePreview(source, config.cacheDir, info.id, info.fileVersion)
    throwIfAborted(execCtx.signal)
    return
  }

  if (job.kind === 'hls') {
    const payload = job.payload ? (JSON.parse(job.payload) as { generationId?: string }) : {}
    if (payload.generationId) {
      await runHlsGeneration(db, config, job, info, source, payload.generationId, execCtx)
      throwIfAborted(execCtx.signal)
      return
    }

    const encode = (hwaccel: 'nvenc' | null, leaseSignal?: AbortSignal) => {
      const combined = leaseSignal && execCtx.signal
        ? AbortSignal.any([execCtx.signal, leaseSignal])
        : (execCtx.signal ?? leaseSignal)
      return generateHls(source, config.cacheDir, info.id, info.fileVersion, {
        hwaccel,
        width: info.width,
        signal: combined,
      })
    }

    if (config.hwaccel !== 'nvenc') {
      await encode(config.hwaccel)
      throwIfAborted(execCtx.signal)
      return
    }

    await withGpuLease(
      db,
      {
        resourceId: config.gpuResource,
        owner: config.workerId,
        taskKind: 'hls',
        waitMs: HLS_LEASE_WAIT_MS,
        leaseMs: HLS_LEASE_MS,
      },
      (held, leaseSignal) => encode(held ? 'nvenc' : null, leaseSignal),
    )
    throwIfAborted(execCtx.signal)
    return
  }

  throw new Error(`unknown job kind: ${job.kind}`)
}
