import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  createTranslationJob,
  getAssetFileInfo,
  latestTranslationJob,
} from '@mediavault/database'
import { newId } from '@mediavault/shared'
import type { AppContext } from '../context'
import { toTranslationDTO, toTranslationJobDTO, toTranslationSummaryDTO } from '../dto'
import { ORIGINAL, currentTranscript, currentTranslation } from '../subtitles'
import { translationTarget } from '../translation-trigger'
import { parseInput } from '../validate'

const idParams = z.object({ id: z.string().min(1).max(64) })
const langQuery = z.object({ lang: z.string().min(1).max(16).optional() })
const requestBody = z
  .object({
    targetLanguage: z.string().min(2).max(16).optional(),
    force: z.boolean().optional(),
  })
  .optional()

function notFound(reply: FastifyReply): void {
  reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
}

function unavailable(reply: FastifyReply): void {
  reply.code(503).send({
    error: 'translation_disabled',
    message: 'Subtitle translation is not configured on this server.',
  })
}

function baseLanguage(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/)[0] ?? tag
}

function matchesRunningModel(ctx: AppContext, job: { modelSha256: string; promptVersion: string; pipelineVersion: string }): boolean {
  return (
    job.modelSha256 === ctx.config.translation.modelSha256 &&
    job.promptVersion === ctx.config.translation.promptVersion &&
    job.pipelineVersion === ctx.config.translation.pipelineVersion
  )
}

export function registerTranslationRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/assets/:id/translations', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const body = parseInput(requestBody, request.body ?? {}, reply)
    if (!body) return
    if (!ctx.config.translation.enabled) {
      unavailable(reply)
      return
    }

    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null || info.kind !== 'video') {
      notFound(reply)
      return
    }

    const transcript = currentTranscript(ctx, info.id, info.fileVersion)
    if (!transcript) {
      reply.code(409).send({
        error: 'no_transcript',
        message: 'Create the source transcript before translating it.',
      })
      return
    }

    const target = body.targetLanguage ?? ctx.config.translation.targetLanguage
    if (baseLanguage(target) === baseLanguage(transcript.transcript.language)) {
      reply.send({ job: null, translation: null })
      return
    }

    const existing = currentTranslation(ctx, transcript.transcript, target)
    if (existing && !body.force) {
      reply.send({
        job: null,
        translation: toTranslationSummaryDTO(existing.translation, existing.segments.length),
      })
      return
    }

    const job = createTranslationJob(
      ctx.db,
      {
        id: newId(16),
        sourceTranscriptId: transcript.transcript.id,
        assetId: transcript.transcript.assetId,
        fileVersion: transcript.transcript.fileVersion,
        sourceLanguage: transcript.transcript.language,
        targetLanguage: target,
        modelId: ctx.config.translation.modelId,
        modelRevision: ctx.config.translation.modelRevision,
        modelSha256: ctx.config.translation.modelSha256,
        promptVersion: ctx.config.translation.promptVersion,
        pipelineVersion: ctx.config.translation.pipelineVersion,
      },
      Date.now(),
    )
    reply.code(202).send({ job: toTranslationJobDTO(job), translation: null })
  })

  app.get('/api/assets/:id/translations/status', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const query = parseInput(langQuery, request.query, reply)
    if (!query) return

    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null) {
      notFound(reply)
      return
    }

    const transcript = currentTranscript(ctx, info.id, info.fileVersion)
    const target = query.lang ?? ctx.config.translation.targetLanguage
    const latest = transcript
      ? latestTranslationJob(ctx.db, info.id, info.fileVersion, target)
      : null
    const job = latest && matchesRunningModel(ctx, latest) ? latest : null
    const stored = transcript ? currentTranslation(ctx, transcript.transcript, target) : null

    reply.send({
      available: ctx.config.translation.enabled,
      job: job ? toTranslationJobDTO(job) : null,
      translation: stored
        ? toTranslationSummaryDTO(stored.translation, stored.segments.length)
        : null,
    })
  })

  app.get('/api/assets/:id/translation', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const query = parseInput(langQuery, request.query, reply)
    if (!query) return

    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null) {
      notFound(reply)
      return
    }

    const transcript = currentTranscript(ctx, info.id, info.fileVersion)
    if (!transcript) {
      reply.code(404).send({ error: 'not_found', message: 'No translation yet.' })
      return
    }

    const target = query.lang ?? ctx.config.translation.targetLanguage
    const stored = currentTranslation(ctx, transcript.transcript, target)
    if (!stored) {
      reply.code(404).send({ error: 'not_found', message: 'No translation yet.' })
      return
    }
    reply.send(toTranslationDTO(stored))
  })

  app.get('/api/assets/:id/subtitle-tracks', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return

    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null) {
      notFound(reply)
      return
    }

    const transcript = currentTranscript(ctx, info.id, info.fileVersion)
    if (!transcript) {
      reply.send({ tracks: [], defaultLanguage: null })
      return
    }

    const target = translationTarget(ctx, transcript.transcript)
    const stored = target ? currentTranslation(ctx, transcript.transcript, target) : null
    const tracks: Array<{ language: string; source: 'asr' | 'translation'; ready: boolean }> = [
      { language: transcript.transcript.language, source: 'asr', ready: true },
    ]
    if (target) {
      tracks.push({ language: target, source: 'translation', ready: Boolean(stored) })
    }

    reply.send({
      tracks,
      defaultLanguage: stored ? target : ORIGINAL,
    })
  })
}
