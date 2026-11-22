import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  getAssetFileInfo,
  getCurrentScenes,
  getScene,
  getSceneCoverage,
} from '@mediavault/database'
import type { SceneDTO } from '@mediavault/shared'
import type { AppContext } from '../context'
import { accelPathFor, sendFile } from '../http'
import { enqueueScenes } from '../scene-trigger'
import { parseInput } from '../validate'

const idParams = z.object({ id: z.string().min(1).max(64) })
export function registerSceneRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/assets/:id/scenes', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return

    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }

    const scenes = getCurrentScenes(ctx.db, info.id, info.fileVersion, {
      modelSha256: ctx.config.scene.modelSha256,
      pipelineVersion: ctx.config.scene.pipelineVersion,
    })
    const payload: SceneDTO[] = scenes.map((scene) => ({
      id: scene.id,
      assetId: scene.assetId,
      seq: scene.seq,
      startMs: scene.startMs,
      endMs: scene.endMs,
      thumbnailUrl: scene.thumbnailPath ? `/api/scenes/${scene.id}/thumbnail` : null,
    }))
    reply.send({
      scenes: payload,
      coverage: getSceneCoverage(ctx.db, info.id, info.fileVersion, {
        modelSha256: ctx.config.scene.modelSha256,
        pipelineVersion: ctx.config.scene.pipelineVersion,
      }),
    })
  })

  app.post('/api/assets/:id/scenes', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return

    if (!ctx.config.scene.enabled) {
      reply.code(409).send({ error: 'disabled', message: 'Scene search is not configured.' })
      return
    }
    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    if (info.kind !== 'video') {
      reply.code(422).send({ error: 'not_a_video', message: 'Only videos have scenes.' })
      return
    }

    const job = enqueueScenes(ctx, info.id, info.fileVersion, Date.now())
    reply.code(202).send({ queued: job !== null, jobId: job?.id ?? null })
  })

  app.get('/api/scenes/:id/thumbnail', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return

    const scene = getScene(ctx.db, params.id)
    if (!scene || !scene.thumbnailPath) {
      reply.code(404).send({ error: 'not_found', message: 'Scene not found.' })
      return
    }
    const target = path.join(ctx.config.cacheDir, scene.thumbnailPath)
    const accel = ctx.config.accel
      ? accelPathFor('/internal/cache', scene.thumbnailPath)
      : undefined
    await sendFile(request, reply, target, 'image/jpeg', {
      cacheControl: 'public, max-age=31536000, immutable',
      ...(accel ? { accelPath: accel } : {}),
    })
  })

}
