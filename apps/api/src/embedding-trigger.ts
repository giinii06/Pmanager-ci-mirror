import { createEmbeddingJob, getAssetFileInfo, getTranscript } from '@mediavault/database'
import type { EmbeddingJobRecord } from '@mediavault/database'
import { newId } from '@mediavault/shared'
import type { AppContext } from './context'

/**
 * Queues one embedding pass for a file version. The transcript lookup is the
 * newest one, not the one the ASR fingerprint accepts, because the reader that
 * ranks by similarity resolves the same row.
 */
export function enqueueEmbedding(
  ctx: AppContext,
  assetId: string,
  fileVersion: number,
  now: number,
): EmbeddingJobRecord | null {
  if (!ctx.config.embedding.enabled) return null

  const asset = getAssetFileInfo(ctx.db, assetId)
  if (!asset || asset.deletedAt !== null) return null

  const source = getTranscript(ctx.db, assetId, fileVersion)
  return createEmbeddingJob(
    ctx.db,
    {
      id: newId(16),
      assetId,
      fileVersion,
      sourceTranscriptId: source?.transcript.id ?? null,
      modelId: ctx.config.embedding.modelId,
      modelRevision: ctx.config.embedding.modelRevision,
      modelSha256: ctx.config.embedding.modelSha256,
      pipelineVersion: ctx.config.embedding.pipelineVersion,
      dimensions: ctx.config.embedding.dimensions,
    },
    now,
  )
}
