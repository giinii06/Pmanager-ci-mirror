import path from 'node:path'
import {
  getTranscript,
  getTranslation,
  isCurrentTranslation,
  type AssetFileInfo,
  type TranscriptRecord,
  type TranscriptWithSegments,
  type TranslationWithSegments,
} from '@mediavault/database'
import { resolveInside } from '@mediavault/media'
import type { AppContext } from './context'

export const ORIGINAL = 'original'

export type SubtitleSource =
  | { kind: 'asr'; language: string; transcript: TranscriptRecord; segmentCount: number }
  | { kind: 'translation'; language: string; translation: TranslationWithSegments['translation']; segmentCount: number }

/**
 * Subtitles belong to the file version that produced them, and a stored
 * transcript only counts while the running model revisions match it.
 */
export function currentTranscript(
  ctx: AppContext,
  assetId: string,
  fileVersion: number,
): TranscriptWithSegments | null {
  const stored = getTranscript(ctx.db, assetId, fileVersion)
  if (!stored) return null
  const { transcript } = stored
  if (
    transcript.modelRevision !== ctx.config.asr.modelRevision ||
    transcript.alignerRevision !== ctx.config.asr.alignerRevision ||
    transcript.pipelineVersion !== ctx.config.asr.pipelineVersion
  ) {
    return null
  }
  return stored
}

/**
 * A translation only counts when it was built from this transcript with the
 * running model, prompt, and pipeline, so an old cache entry never leaks.
 */
export function currentTranslation(
  ctx: AppContext,
  transcript: TranscriptRecord,
  targetLanguage: string,
): TranslationWithSegments | null {
  if (!ctx.config.translation.enabled) return null
  const stored = getTranslation(ctx.db, transcript.assetId, transcript.fileVersion, targetLanguage)
  if (!stored) return null
  if (
    !isCurrentTranslation(stored.translation, transcript.id, {
      modelSha256: ctx.config.translation.modelSha256,
      promptVersion: ctx.config.translation.promptVersion,
      pipelineVersion: ctx.config.translation.pipelineVersion,
    })
  ) {
    return null
  }
  return stored
}

/**
 * `original` and a missing `lang` both mean the ASR track, which keeps every
 * existing URL working. A language equal to the source needs no translation.
 */
export function resolveSubtitleSource(
  ctx: AppContext,
  info: AssetFileInfo,
  lang: string | undefined,
): SubtitleSource | null {
  const transcript = currentTranscript(ctx, info.id, info.fileVersion)
  if (!transcript) return null

  if (!lang || lang === ORIGINAL || lang === transcript.transcript.language) {
    return {
      kind: 'asr',
      language: transcript.transcript.language,
      transcript: transcript.transcript,
      segmentCount: transcript.segments.length,
    }
  }

  const stored = currentTranslation(ctx, transcript.transcript, lang)
  if (!stored) return null
  return {
    kind: 'translation',
    language: stored.translation.targetLanguage,
    translation: stored.translation,
    segmentCount: stored.segments.length,
  }
}

/**
 * Returns the absolute subtitle file for a resolved track, or null when the
 * path escapes the configured result directory.
 */
export function subtitleFile(
  ctx: AppContext,
  source: SubtitleSource,
  name: 'subtitles.vtt' | 'subtitles.srt',
): string | null {
  const root = source.kind === 'asr' ? ctx.config.asr.resultDir : ctx.config.translation.resultDir
  const dir = source.kind === 'asr' ? source.transcript.resultDir : source.translation.resultDir
  return resolveInside(root, path.join(dir, name))
}
