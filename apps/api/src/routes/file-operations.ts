import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  createDeleteMutation,
  createMoveMutation,
  getFileMutation,
  getLibrary,
  getLibraryHealth,
  getMutationAsset,
  retryFileMutation,
} from '@mediavault/database'
import type { AppContext } from '../context'
import { toFileOperationDTO } from '../dto'
import { joinTargetPath, normalizeTargetFolder } from '../target-path'
import { parseInput } from '../validate'

const idParams = z.object({ id: z.string().min(1).max(64) })

const moveBody = z.object({
  targetLibraryId: z.string().min(1).max(64),
  targetFolder: z.string().max(1_024).optional(),
})

function idempotencyKey(headers: Record<string, unknown>): string | null {
  const raw = headers['idempotency-key']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : null
}

export function registerFileOperationRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/assets/:id/delete-operations', async (request, reply) => {
    if (!ctx.config.fileMutationEnabled) {
      request.log.warn('file mutation engine disabled; refusing a delete request')
      reply
        .code(503)
        .send({ error: 'mutation_engine_disabled', message: 'The delete engine is turned off.' })
      return
    }
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const key = idempotencyKey(request.headers)
    if (!key) {
      reply.code(400).send({
        error: 'idempotency_key_required',
        message: 'Send an Idempotency-Key header with the delete request.',
      })
      return
    }

    const asset = getMutationAsset(ctx.db, params.id)
    if (!asset || asset.deletedAt !== null) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    const health = getLibraryHealth(ctx.db, asset.libraryId)
    if (!health || health.state !== 'ONLINE') {
      reply.code(409).send({
        error: 'source_offline',
        message: 'The library that holds this file is not online.',
      })
      return
    }

    const result = createDeleteMutation(ctx.db, {
      assetId: asset.id,
      libraryId: asset.libraryId,
      userId: request.user!.id,
      requestKey: `${request.user!.id}:${key}`,
      requestedFileVersion: asset.fileVersion,
      sourceRel: asset.relativePath,
      now: Date.now(),
    })
    request.log.info(
      { operationId: result.record.id, created: result.created, assetId: asset.id },
      'delete operation requested',
    )
    reply.code(202).send(toFileOperationDTO(result.record))
  })

  app.post('/api/assets/:id/move-operations', async (request, reply) => {
    if (!ctx.config.fileMutationEnabled) {
      request.log.warn('file mutation engine disabled; refusing a move request')
      reply
        .code(503)
        .send({ error: 'mutation_engine_disabled', message: 'The file engine is turned off.' })
      return
    }
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const body = parseInput(moveBody, request.body ?? {}, reply)
    if (!body) return
    const key = idempotencyKey(request.headers)
    if (!key) {
      reply.code(400).send({
        error: 'idempotency_key_required',
        message: 'Send an Idempotency-Key header with the move request.',
      })
      return
    }

    const asset = getMutationAsset(ctx.db, params.id)
    if (!asset || asset.deletedAt !== null) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    const health = getLibraryHealth(ctx.db, asset.libraryId)
    if (!health || health.state !== 'ONLINE') {
      reply.code(409).send({
        error: 'source_offline',
        message: 'The library that holds this file is not online.',
      })
      return
    }
    const target = getLibrary(ctx.db, body.targetLibraryId)
    if (!target) {
      reply.code(404).send({ error: 'target_missing', message: 'Target library not found.' })
      return
    }
    const folder = normalizeTargetFolder(body.targetFolder)
    if (folder === null) {
      reply.code(400).send({ error: 'target_folder_invalid', message: 'Invalid target folder.' })
      return
    }
    const targetHealth = getLibraryHealth(ctx.db, target.id)
    if (!targetHealth || targetHealth.state !== 'ONLINE') {
      reply.code(409).send({ error: 'target_offline', message: 'The target library is not online.' })
      return
    }
    const targetRel = joinTargetPath(folder, asset.filename)
    if (target.id === asset.libraryId && targetRel === asset.relativePath) {
      reply.code(409).send({
        error: 'target_same_as_source',
        message: 'The file is already at that location.',
      })
      return
    }

    const result = createMoveMutation(ctx.db, {
      assetId: asset.id,
      libraryId: asset.libraryId,
      userId: request.user!.id,
      requestKey: `${request.user!.id}:${key}`,
      requestedFileVersion: asset.fileVersion,
      sourceRel: asset.relativePath,
      targetLibraryId: target.id,
      targetRel,
      now: Date.now(),
    })
    request.log.info(
      {
        operationId: result.record.id,
        created: result.created,
        assetId: asset.id,
        targetLibraryId: target.id,
      },
      'move operation requested',
    )
    reply.code(202).send(toFileOperationDTO(result.record))
  })

  app.get('/api/file-operations/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const record = getFileMutation(ctx.db, params.id)
    if (!record) {
      reply.code(404).send({ error: 'not_found', message: 'Operation not found.' })
      return
    }
    reply.send(toFileOperationDTO(record))
  })

  app.post('/api/file-operations/:id/retry', async (request, reply) => {
    if (!ctx.config.fileMutationEnabled) {
      reply
        .code(503)
        .send({ error: 'mutation_engine_disabled', message: 'The delete engine is turned off.' })
      return
    }
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const record = getFileMutation(ctx.db, params.id)
    if (!record) {
      reply.code(404).send({ error: 'not_found', message: 'Operation not found.' })
      return
    }
    if (!retryFileMutation(ctx.db, record.id, Date.now())) {
      reply.code(409).send({
        error: 'operation_not_retryable',
        message: 'Only a failed operation that no worker holds can be retried.',
      })
      return
    }
    reply.code(202).send(toFileOperationDTO(getFileMutation(ctx.db, record.id)!))
  })
}
