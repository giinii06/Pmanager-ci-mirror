import path from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  createAsrJob,
  getAssetFileInfo,
  getTranscript,
  latestAsrJob,
  searchTranscript,
  type TranscriptRecord,
} from '@mediavault/database'
import { newId } from '@mediavault/shared'
import { fileExists, resolveInside } from '@mediavault/media'
import type { AppContext } from '../context'
import { toAsrJobDTO, toTranscriptDTO, toTranscriptSummaryDTO } from '../dto'
import { sendFile } from '../http'
import { parseInput } from '../validate'

const idParams = z.object({ id: z.string().min(1).max(64) })
const searchQuery = z.object({ q: z.string().trim().min(1).max(100) })
const transcribeBody = z.object({ force: z.boolean().optional() }).optional()

function notFound(reply: FastifyReply): void {
  reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
}

function unavailable(reply: FastifyReply): void {
  reply.code(503).send({
    error: 'asr_disabled',
    message: 'Subtitle generation is not configured on this server.',
  })
}

/**
 * Subtitles belong to the file version that produced them. A replaced file
 * must never inherit the old transcript.
 */
function currentTranscript(ctx: AppContext, assetId: string, fileVersion: number) {
  const stored = getTranscript(ctx.db, assetId, fileVersion)
  if (!stored) return null
  const { transcript, segments } = stored
  if (
    transcript.modelRevision !== ctx.config.asr.modelRevision ||
    transcript.alignerRevision !== ctx.config.asr.alignerRevision ||
    transcript.pipelineVersion !== ctx.config.asr.pipelineVersion
  ) {
    return null
  }
  return stored
}

function subtitleFile(
  ctx: AppContext,
  transcript: TranscriptRecord,
  name: 'subtitles.vtt' | 'subtitles.srt',
): string | null {
  const target = resolveInside(ctx.config.asr.resultDir, path.join(transcript.resultDir, name))
  if (!target) return null
  return target
}

export function registerTranscriptionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/assets/:id/transcribe', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const body = parseInput(transcribeBody, request.body ?? {}, reply)
    if (!body) return
    if (!ctx.config.asr.enabled) {
      unavailable(reply)
      return
    }

    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null || info.kind !== 'video') {
      notFound(reply)
      return
    }

    const existing = currentTranscript(ctx, info.id, info.fileVersion)
    if (existing && !body.force) {
      reply.send({
        job: null,
        transcript: toTranscriptSummaryDTO(existing.transcript, existing.segments.length),
      })
      return
    }

    const job = createAsrJob(
      ctx.db,
      {
        id: newId(16),
        assetId: info.id,
        fileVersion: info.fileVersion,
        modelRevision: ctx.config.asr.modelRevision,
        alignerRevision: ctx.config.asr.alignerRevision,
        pipelineVersion: ctx.config.asr.pipelineVersion,
      },
      Date.now(),
    )
    reply.code(202).send({ job: toAsrJobDTO(job), transcript: null })
  })

  app.get('/api/assets/:id/transcription/status', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return

    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null) {
      notFound(reply)
      return
    }

    const stored = currentTranscript(ctx, info.id, info.fileVersion)
    const job = ctx.config.asr.enabled ? latestAsrJob(ctx.db, info.id, info.fileVersion) : null
    reply.send({
      available: ctx.config.asr.enabled,
      job: job ? toAsrJobDTO(job) : null,
      transcript: stored
        ? toTranscriptSummaryDTO(stored.transcript, stored.segments.length)
        : null,
    })
  })

  app.get('/api/assets/:id/transcription', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return

    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null) {
      notFound(reply)
      return
    }

    const stored = currentTranscript(ctx, info.id, info.fileVersion)
    if (!stored) {
      reply.code(404).send({ error: 'not_found', message: 'No transcript yet.' })
      return
    }
    reply.send(toTranscriptDTO(stored))
  })

  app.get('/api/assets/:id/transcript/search', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const query = parseInput(searchQuery, request.query, reply)
    if (!query) return

    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null) {
      notFound(reply)
      return
    }

    const stored = currentTranscript(ctx, info.id, info.fileVersion)
    if (!stored) {
      reply.send({ query: query.q, hits: [] })
      return
    }
    reply.send({
      query: query.q,
      hits: searchTranscript(ctx.db, stored.transcript.id, query.q).map((segment) => ({
        seq: segment.seq,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
      })),
    })
  })

  for (const [route, name, contentType] of [
    ['subtitles.vtt', 'subtitles.vtt', 'text/vtt; charset=utf-8'],
    ['subtitles.srt', 'subtitles.srt', 'application/x-subrip; charset=utf-8'],
  ] as const) {
    app.get(`/api/assets/:id/${route}`, async (request, reply) => {
      const params = parseInput(idParams, request.params, reply)
      if (!params) return

      const info = getAssetFileInfo(ctx.db, params.id)
      if (!info || info.deletedAt !== null) {
        notFound(reply)
        return
      }

      const stored = currentTranscript(ctx, info.id, info.fileVersion)
      const target = stored ? subtitleFile(ctx, stored.transcript, name) : null
      if (!target || !(await fileExists(target))) {
        reply.code(404).send({ error: 'not_found', message: 'No subtitles yet.' })
        return
      }

      const download = name === 'subtitles.srt' ? `attachment; filename="${info.id}.srt"` : undefined
      await sendFile(request, reply, target, contentType, {
        cacheControl: 'private, max-age=60',
        ...(download ? { contentDisposition: download } : {}),
      })
    })
  }
}
