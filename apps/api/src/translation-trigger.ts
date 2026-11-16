import {
  createTranslationJob,
  getTranslation,
  isCurrentTranslation,
  type TranslationJobRecord,
  type TranscriptRecord,
} from '@mediavault/database'
import { newId } from '@mediavault/shared'
import type { AppContext } from './context'

function baseLanguage(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/)[0] ?? tag
}

/**
 * A Korean source is already the Korean track, so no job is created. Returns
 * null when translation is off, the file has no speech, or the source already
 * speaks the target.
 */
export function translationTarget(ctx: AppContext, transcript: TranscriptRecord): string | null {
  if (!ctx.config.translation.enabled) return null
  if (transcript.hasSpeech === 0) return null
  const target = ctx.config.translation.targetLanguage
  if (baseLanguage(transcript.language) === baseLanguage(target)) return null
  return target
}

/**
 * Called after an ASR job commits. A current translation is reused, and a job
 * that is already queued or running is left alone.
 */
export function enqueueTranslation(
  ctx: AppContext,
  transcript: TranscriptRecord,
  now: number,
): TranslationJobRecord | null {
  const target = translationTarget(ctx, transcript)
  if (!target) return null

  const stored = getTranslation(ctx.db, transcript.assetId, transcript.fileVersion, target)
  if (
    stored &&
    isCurrentTranslation(stored.translation, transcript.id, {
      modelSha256: ctx.config.translation.modelSha256,
      promptVersion: ctx.config.translation.promptVersion,
      pipelineVersion: ctx.config.translation.pipelineVersion,
    })
  ) {
    return null
  }

  return createTranslationJob(
    ctx.db,
    {
      id: newId(16),
      sourceTranscriptId: transcript.id,
      assetId: transcript.assetId,
      fileVersion: transcript.fileVersion,
      sourceLanguage: transcript.language,
      targetLanguage: target,
      modelId: ctx.config.translation.modelId,
      modelRevision: ctx.config.translation.modelRevision,
      modelSha256: ctx.config.translation.modelSha256,
      promptVersion: ctx.config.translation.promptVersion,
      pipelineVersion: ctx.config.translation.pipelineVersion,
    },
    now,
  )
}
