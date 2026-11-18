import { createSceneJob, getAssetFileInfo } from '@mediavault/database'
import type { SceneJobRecord } from '@mediavault/database'
import { newId } from '@mediavault/shared'
import type { AppContext } from './context'

/**
 * Queues one scene pass for a file version. Scenes only need the picture and the
 * sound, so unlike embeddings this never waits for a transcript.
 */
export function enqueueScenes(
  ctx: AppContext,
  assetId: string,
  fileVersion: number,
  now: number,
): SceneJobRecord | null {
  if (!ctx.config.scene.enabled) return null

  const asset = getAssetFileInfo(ctx.db, assetId)
  if (!asset || asset.deletedAt !== null) return null
  if (asset.kind !== 'video') return null

  return createSceneJob(
    ctx.db,
    {
      id: newId(16),
      assetId,
      fileVersion,
      modelId: ctx.config.scene.modelId,
      modelRevision: ctx.config.scene.modelRevision,
      modelSha256: ctx.config.scene.modelSha256,
      pipelineVersion: ctx.config.scene.pipelineVersion,
      dimensions: ctx.config.scene.dimensions,
      windowMs: ctx.config.scene.windowMs,
      overlapMs: ctx.config.scene.overlapMs,
    },
    now,
  )
}
