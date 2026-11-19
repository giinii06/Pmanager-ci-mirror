import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  applyPlayEvent,
  createPlaySession,
  getAssetFileInfo,
  type PlayEventResult,
} from '@mediavault/database'
import { newId } from '@mediavault/shared'
import type { AppContext } from '../context'
import { toPlaybackDTO } from '../dto'
import { parseInput } from '../validate'

const sessionParams = z.object({ sessionId: z.string().min(8).max(64) })

const sessionBody = z.object({
  assetId: z.string().min(1).max(64),
  fileVersion: z.number().int().min(0).max(2_147_483_647),
  clientSessionKey: z
    .string()
    .min(8)
    .max(100)
    .regex(/^[A-Za-z0-9_-]+$/),
})

const eventBody = z
  .object({
    eventId: z
      .string()
      .min(8)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/),
    seq: z.number().int().min(1).max(2_147_483_647),
    type: z.enum(['watch_time', 'progress', 'view']),
    deltaMs: z.number().int().min(1).max(600_000).optional(),
    positionMs: z.number().finite().min(0).max(86_400_000).optional(),
    durationMs: z.number().finite().min(0).max(86_400_000).optional(),
    clientTimestamp: z.number().int().min(0).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.type === 'watch_time' && body.deltaMs === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['deltaMs'],
        message: 'A watch_time event needs deltaMs.',
      })
    }
    if (body.type === 'progress') {
      if (body.positionMs === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['positionMs'],
          message: 'A progress event needs positionMs.',
        })
      }
      if (body.durationMs === undefined || body.durationMs <= 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['durationMs'],
          message: 'A progress event needs a positive durationMs.',
        })
      }
    }
  })

function sendEventResult(reply: FastifyReply, result: PlayEventResult): void {
  switch (result.status) {
    case 'not_found':
      reply.code(404).send({ error: 'not_found', message: 'Play session not found.' })
      return
    case 'asset_gone':
      reply
        .code(410)
        .send({ error: 'asset_gone', message: 'The asset is no longer available.' })
      return
    case 'invalid':
      reply.code(400).send({ error: 'invalid_event', message: 'The event payload is not valid.' })
      return
    case 'sequence_gap':
      reply.code(409).send({
        error: 'sequence_gap',
        expectedSeq: result.expectedSeq,
        message: `The next event must use seq ${result.expectedSeq}.`,
      })
      return
    case 'sequence_conflict':
      reply.code(409).send({
        error: 'sequence_conflict',
        message: 'The sequence was already used by another event.',
      })
      return
    case 'event_id_conflict':
      reply.code(409).send({
        error: 'event_id_conflict',
        message: 'The event id was already used with a different payload.',
      })
      return
    case 'file_version_changed':
      reply.code(409).send({
        error: 'file_version_changed',
        fileVersion: result.fileVersion,
        message: 'The asset changed since this playback started.',
      })
      return
    default:
      reply.send({
        applied: result.status === 'applied',
        duplicate: result.duplicate,
        viewCount: result.viewCount,
        watchTimeMs: result.watchTimeMs,
        progress: result.progress ? toPlaybackDTO(result.progress) : null,
        lastSeq: result.lastSeq,
      })
  }
}

export function registerPlaybackRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/play-sessions', async (request, reply) => {
    const body = parseInput(sessionBody, request.body, reply)
    if (!body) return

    const asset = getAssetFileInfo(ctx.db, body.assetId)
    if (!asset || asset.deletedAt !== null || asset.kind !== 'video') {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    if (asset.fileVersion !== body.fileVersion) {
      reply.code(409).send({
        error: 'file_version_changed',
        fileVersion: asset.fileVersion,
        message: 'The asset changed since it was loaded.',
      })
      return
    }

    const created = createPlaySession(ctx.db, {
      id: newId(20),
      userId: request.user!.id,
      assetId: asset.id,
      fileVersion: asset.fileVersion,
      clientSessionKey: body.clientSessionKey,
      now: Date.now(),
    })
    if (created.status === 'session_key_conflict') {
      if (created.session.assetId !== asset.id) {
        reply.code(409).send({
          error: 'session_key_conflict',
          message: 'The session key is already used for another asset.',
        })
        return
      }
      reply.code(409).send({
        error: 'file_version_changed',
        fileVersion: asset.fileVersion,
        message: 'The playback session belongs to a previous file version.',
      })
      return
    }

    reply.code(created.status === 'created' ? 201 : 200).send({
      sessionId: created.session.id,
      assetId: created.session.assetId,
      fileVersion: created.session.fileVersion,
      issuedAt: new Date(created.session.startedAt).toISOString(),
    })
  })

  app.post('/api/play-sessions/:sessionId/events', async (request, reply) => {
    const params = parseInput(sessionParams, request.params, reply)
    if (!params) return
    const body = parseInput(eventBody, request.body, reply)
    if (!body) return

    const result = applyPlayEvent(ctx.db, {
      eventId: body.eventId,
      sessionId: params.sessionId,
      userId: request.user!.id,
      seq: body.seq,
      type: body.type,
      deltaMs: body.deltaMs ?? null,
      positionMs: body.positionMs ?? null,
      durationMs: body.durationMs ?? null,
      clientTimestamp: body.clientTimestamp ?? null,
      now: Date.now(),
    })
    sendEventResult(reply, result)
  })
}
