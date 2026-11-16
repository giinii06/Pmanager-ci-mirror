import path from 'node:path'
import {
  getTranscript,
  getTranslation,
  isCurrentTranslation,
  type AssetFileInfo,
  type TranscriptRecord,
  type TranscriptSegmentRecord,
  type TranscriptWithSegments,
  type TranslationRecord,
  type TranslationSegmentRecord,
  type TranslationWithSegments,
} from '@mediavault/database'
import { resolveInside } from '@mediavault/media'
import type { AppContext } from './context'

export const ORIGINAL = 'original'

export type SubtitleSource =
  | { kind: 'asr'; language: string; transcript: TranscriptRecord }
  | {
      kind: 'translation'
      language: string
      translation: TranslationRecord
      segments: TranslationSegmentRecord[]
      /** The ASR cues the translation was built from, shown above each line. */
      sourceSegments: TranscriptSegmentRecord[]
    }

/**
 * Subtitles belong to the file version that produced them, and a stored
 * transcript only counts while the running model revisions match it.
 */
function isCurrentTranscript(ctx: AppContext, transcript: TranscriptRecord): boolean {
  return (
    transcript.modelRevision === ctx.config.asr.modelRevision &&
    transcript.alignerRevision === ctx.config.asr.alignerRevision &&
    transcript.pipelineVersion === ctx.config.asr.pipelineVersion
  )
}

/**
 * The transcript row alone, without its segments, for callers that only need to
 * know whether a current transcript exists.
 */
export function currentTranscriptRecord(
  ctx: AppContext,
  assetId: string,
  fileVersion: number,
): TranscriptRecord | null {
  const stored = getTranscript(ctx.db, assetId, fileVersion)
  if (!stored || !isCurrentTranscript(ctx, stored.transcript)) return null
  return stored.transcript
}

export function currentTranscript(
  ctx: AppContext,
  assetId: string,
  fileVersion: number,
): TranscriptWithSegments | null {
  const stored = getTranscript(ctx.db, assetId, fileVersion)
  if (!stored || !isCurrentTranscript(ctx, stored.transcript)) return null
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
  if (transcript.transcript.hasSpeech === 0) return null

  if (!lang || lang === ORIGINAL || lang === transcript.transcript.language) {
    return {
      kind: 'asr',
      language: transcript.transcript.language,
      transcript: transcript.transcript,
    }
  }

  const stored = currentTranslation(ctx, transcript.transcript, lang)
  if (!stored) return null
  return {
    kind: 'translation',
    language: stored.translation.targetLanguage,
    translation: stored.translation,
    segments: stored.segments,
    sourceSegments: transcript.segments,
  }
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1_000)
  const millis = total % 1_000
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`
}

/** A cue is one line in WebVTT, so a stored line break becomes a space. */
function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim()
}

export interface DualSubtitleCues {
  segments: TranslationSegmentRecord[]
  sourceSegments: TranscriptSegmentRecord[]
}

/**
 * The track a viewer picks when the file is not in their language: the line
 * that was spoken on top, the translation under it. The translation keeps the
 * source seq, which is what pairs the two rows.
 */
export function dualSubtitleVtt(source: DualSubtitleCues): string {
  const original = new Map(source.sourceSegments.map((segment) => [segment.seq, segment.text]))
  const cues = source.segments
    .map((segment) => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      lines: [oneLine(original.get(segment.seq) ?? ''), oneLine(segment.text)],
    }))
    .filter((cue) => cue.lines[1] !== '')

  const blocks = ['WEBVTT', '']
  cues.forEach((cue, index) => {
    // A cue end is exclusive, so ending where the next line starts keeps this
    // one on screen through the silence instead of blinking off.
    const next = cues[index + 1]
    const end = next && next.startMs > cue.endMs ? next.startMs : cue.endMs
    blocks.push(String(index + 1))
    blocks.push(`${clock(cue.startMs)} --> ${clock(end)}`)
    blocks.push(cue.lines.filter(Boolean).join('\n'))
    blocks.push('')
  })
  return blocks.join('\n')
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
