import {
  activeAsrJob,
  activeFaceJob,
  activeSceneJob,
  createAsrJob,
  enqueueJob,
  latestAsrJob,
  listLibraries,
  listVideosForIndexing,
  setScanState,
} from '@mediavault/database'
import { PRIORITY, newId } from '@mediavault/shared'
import type { AppContext } from './context'
import { enqueueEmbedding } from './embedding-trigger'
import { enqueueFaces, enqueueScenes } from './scene-trigger'
import { currentTranscriptRecord } from './subtitles'
import { enqueueTranslation } from './translation-trigger'

const BATCH = 500

export interface PipelinePass {
  scanned: number
  considered: number
  asr: number
  translations: number
  embeddings: number
  scenes: number
  faces: number
}

/**
 * Reconciles every derived artifact with what the library holds.
 *
 * The scanner writes the assets table directly, so the API cannot hear about a
 * new file, and nothing else queues ASR for a video that has no transcript.
 * This pass is the one place that compares what exists with what should exist.
 * It is idempotent: a second run finds every job current and queues nothing.
 */
export function ensurePipelineJobs(ctx: AppContext, now: number, limit = BATCH): PipelinePass {
  const result: PipelinePass = {
    scanned: ensureScans(ctx, now),
    considered: 0,
    asr: 0,
    translations: 0,
    embeddings: 0,
    scenes: 0,
    faces: 0,
  }

  for (const video of listVideosForIndexing(ctx.db, limit)) {
    result.considered += 1
    const transcript = currentTranscriptRecord(ctx, video.id, video.fileVersion)

    if (shouldTranscribe(ctx, video, transcript !== null)) {
      const job = createAsrJob(
        ctx.db,
        {
          id: newId(16),
          assetId: video.id,
          fileVersion: video.fileVersion,
          modelRevision: ctx.config.asr.modelRevision,
          alignerRevision: ctx.config.asr.alignerRevision,
          pipelineVersion: ctx.config.asr.pipelineVersion,
        },
        now,
      )
      if (queuedByThisPass(job, now)) result.asr += 1
    }

    if (transcript) {
      const translation = enqueueTranslation(ctx, transcript, now)
      if (translation && queuedByThisPass(translation, now)) result.translations += 1

      const embedding = enqueueEmbedding(ctx, video.id, video.fileVersion, now)
      if (embedding && queuedByThisPass(embedding, now)) result.embeddings += 1
    }

    if (ctx.config.scene.enabled && !activeSceneJob(ctx.db, video.id, video.fileVersion)) {
      const job = enqueueScenes(ctx, video.id, video.fileVersion, now)
      if (job?.state === 'queued') result.scenes += 1
    }
    if (ctx.config.face.enabled && !activeFaceJob(ctx.db, video.id, video.fileVersion)) {
      const job = enqueueFaces(ctx, video.id, video.fileVersion, now)
      if (job?.state === 'queued') result.faces += 1
    }
  }
  return result
}

/**
 * A queued row stamped with this pass's clock was written by this pass. An older
 * row was already waiting, so counting it would make a repeat pass look busy.
 */
function queuedByThisPass(job: { state: string; updatedAt: number }, now: number): boolean {
  return job.state === 'queued' && job.updatedAt === now
}

function shouldTranscribe(
  ctx: AppContext,
  video: { id: string; fileVersion: number; audioCodec: string | null },
  hasTranscript: boolean,
): boolean {
  if (!ctx.config.asr.enabled || video.audioCodec === null || hasTranscript) return false
  if (activeAsrJob(ctx.db, video.id, video.fileVersion)) return false

  // A job that used every attempt is not retried on a timer. The player can
  // still ask for it again, and that creates a fresh job. A failure from an
  // older pipeline says nothing about the running one, so it is retried.
  const latest = latestAsrJob(ctx.db, video.id, video.fileVersion)
  if (
    latest &&
    latest.pipelineVersion === ctx.config.asr.pipelineVersion &&
    latest.state === 'failed' &&
    latest.attempts >= latest.maxAttempts
  ) {
    return false
  }
  return true
}

/** Queues a scan for every library that has not been scanned recently. */
function ensureScans(ctx: AppContext, now: number): number {
  let queued = 0
  for (const library of listLibraries(ctx.db)) {
    if (library.scanState === 'queued' || library.scanState === 'scanning') continue
    if (library.lastScanAt !== null && now - library.lastScanAt < ctx.config.scanIntervalMs) {
      continue
    }

    setScanState(ctx.db, library.id, 'queued')
    enqueueJob(
      ctx.db,
      {
        dedupeKey: `scan:${library.id}`,
        kind: 'scan_library',
        priority: PRIORITY.next,
        libraryId: library.id,
      },
      now,
    )
    queued += 1
  }
  return queued
}
