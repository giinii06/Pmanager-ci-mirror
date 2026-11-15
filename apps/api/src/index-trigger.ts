import { activeFaceJob, activeSceneJob, listVideosForIndexing } from '@mediavault/database'
import type { AppContext } from './context'
import { enqueueFaces, enqueueScenes } from './scene-trigger'

const BATCH = 500

export interface IndexPass {
  considered: number
  scenes: number
  faces: number
}

/**
 * Queues a scene and a face pass for every video that does not have one yet.
 *
 * The API cannot hook the scanner: the worker writes the assets table directly,
 * so a new file would otherwise sit unindexed until someone clicked it. The
 * pass is idempotent — `createSceneJob` and `createFaceJob` return the finished
 * row when the fingerprint still matches — so running it on a timer is cheap
 * and cannot duplicate work.
 */
export function ensureIndexJobs(ctx: AppContext, now: number, limit = BATCH): IndexPass {
  const result: IndexPass = { considered: 0, scenes: 0, faces: 0 }
  if (!ctx.config.scene.enabled && !ctx.config.face.enabled) return result

  for (const video of listVideosForIndexing(ctx.db, limit)) {
    result.considered += 1
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
