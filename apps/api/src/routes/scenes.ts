import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  getAssetFileInfo,
  getCurrentScenes,
  getScene,
  getSceneCoverage,
  searchAssetNames,
  searchDialogue,
  searchScenes,
  type DialogueHit,
  type SceneSearchHit,
} from '@mediavault/database'
import type { SceneDTO, SemanticHitDTO } from '@mediavault/shared'
import type { AppContext } from '../context'
import { accelPathFor, sendFile } from '../http'
import { encodeSceneQuery } from '../scene-query'
import { enqueueScenes } from '../scene-trigger'
import { parseInput } from '../validate'

const idParams = z.object({ id: z.string().min(1).max(64) })
const searchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).optional(),
})

const RRF_K = 60
const SCENE_CANDIDATES = 120
const DIALOGUE_CANDIDATES = 60
const NAME_CANDIDATES = 30

interface Fused {
  hit: SemanticHitDTO
  score: number
}

/**
 * Reciprocal rank fusion. The scene tower and the transcript are different
 * signals with no shared scale, so only their ranks are combined.
 */
function fuse(lists: SemanticHitDTO[][]): SemanticHitDTO[] {
  const scores = new Map<string, Fused>()
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const key = hit.sceneId
        ? `scene:${hit.sceneId}`
        : hit.kind === 'dialogue'
          ? `dialogue:${hit.assetId}:${hit.startMs}:${hit.text.slice(0, 24)}`
          : `asset:${hit.assetId}`
      const previous = scores.get(key)
      const gain = 1 / (RRF_K + rank + 1)
      if (previous) previous.score += gain
      else scores.set(key, { hit, score: gain })
    })
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.hit.assetId.localeCompare(b.hit.assetId))
    .map((entry) => ({ ...entry.hit, score: Number(entry.score.toFixed(6)) }))
}

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

  app.get('/api/search/semantic', async (request, reply) => {
    const query = parseInput(searchQuery, request.query, reply)
    if (!query) return

    const limit = query.limit ?? 30
    const lists: SemanticHitDTO[][] = []
    let scenesSearched = false

    if (ctx.config.scene.enabled) {
      const vectors = await encodeSceneQuery(
        ctx.config.scene.queryUrl,
        query.q,
        ctx.config.scene.dimensions,
      )
      if (vectors) {
        const hits = searchScenes(
          ctx.db,
          vectors,
          {
            modelSha256: ctx.config.scene.modelSha256,
            pipelineVersion: ctx.config.scene.pipelineVersion,
            dimensions: ctx.config.scene.dimensions,
          },
          SCENE_CANDIDATES,
        )
        const withAssets = decorateScenes(ctx, hits)
        if (withAssets.length > 0) lists.push(withAssets)
        scenesSearched = true
      }
    }

    const dialogue = searchDialogue(ctx.db, query.q, DIALOGUE_CANDIDATES)
    if (dialogue.length > 0) lists.push(decorateDialogue(ctx, dialogue))

    const names = searchAssetNames(ctx.db, query.q, NAME_CANDIDATES)
    if (names.length > 0) lists.push(decorateNames(ctx, names))

    reply.send({
      query: query.q,
      hits: fuse(lists).slice(0, limit),
      scenesSearched,
    })
  })
}

function decorateScenes(ctx: AppContext, hits: SceneSearchHit[]): SemanticHitDTO[] {
  const assets = new Map<string, ReturnType<typeof getAssetFileInfo>>()
  return hits.flatMap((hit) => {
    if (!assets.has(hit.assetId)) assets.set(hit.assetId, getAssetFileInfo(ctx.db, hit.assetId))
    const asset = assets.get(hit.assetId)
    if (!asset || asset.deletedAt !== null) return []
    return [
      {
        kind: 'scene' as const,
        assetId: hit.assetId,
        sceneId: hit.sceneId,
        startMs: hit.startMs,
        endMs: hit.endMs,
        score: hit.score,
        source: hit.modality,
        text: '',
        thumbnailUrl: hit.thumbnailPath ? `/api/scenes/${hit.sceneId}/thumbnail` : null,
        asset: {
          id: asset.id,
          filename: asset.filename,
          kind: asset.kind,
          durationMs: asset.durationMs,
        },
      },
    ]
  })
}

function decorateDialogue(ctx: AppContext, hits: DialogueHit[]): SemanticHitDTO[] {
  const assets = new Map<string, ReturnType<typeof getAssetFileInfo>>()
  return hits.flatMap((hit) => {
    if (!assets.has(hit.assetId)) assets.set(hit.assetId, getAssetFileInfo(ctx.db, hit.assetId))
    const asset = assets.get(hit.assetId)
    if (!asset || asset.deletedAt !== null) return []
    return [
      {
        kind: 'dialogue' as const,
        assetId: hit.assetId,
        sceneId: null,
        startMs: hit.startMs,
        endMs: hit.endMs,
        score: 0,
        source: 'dialogue' as const,
        text: hit.text,
        thumbnailUrl: null,
        asset: {
          id: asset.id,
          filename: asset.filename,
          kind: asset.kind,
          durationMs: asset.durationMs,
        },
      },
    ]
  })
}

function decorateNames(
  ctx: AppContext,
  hits: Array<{ assetId: string; filename: string; kind: 'image' | 'video'; durationMs: number | null }>,
): SemanticHitDTO[] {
  return hits.map((hit) => ({
    kind: 'asset' as const,
    assetId: hit.assetId,
    sceneId: null,
    startMs: null,
    endMs: null,
    score: 0,
    source: 'title' as const,
    text: hit.filename,
    thumbnailUrl: null,
    asset: {
      id: hit.assetId,
      filename: hit.filename,
      kind: hit.kind,
      durationMs: hit.durationMs,
    },
  }))
}
