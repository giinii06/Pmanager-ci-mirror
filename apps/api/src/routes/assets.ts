import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  addFavorite,
  deleteReview,
  enqueueJob,
  getAsset,
  getAssetFileInfo,
  getProgress,
  getReview,
  listAssets,
  putProgress,
  relatedAssets,
  relatedByEmbedding,
  removeFavorite,
  upsertReview,
  type AssetFilter,
  type AssetRecord,
} from '@mediavault/database'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, PRIORITY, newId } from '@mediavault/shared'
import { fileExists, thumbnailPath } from '@mediavault/media'
import type { AppContext } from '../context'
import { decodeCursor, encodeCursor } from '../cursor'
import { toAssetDTO, toEmbeddingJobDTO, toPlaybackDTO, toReviewDTO } from '../dto'
import { enqueueEmbedding } from '../embedding-trigger'
import { parseInput } from '../validate'

const idParams = z.object({ id: z.string().min(1).max(64) })

const assetQuery = z.object({
  libraryId: z.string().max(64).optional(),
  folderId: z.string().max(64).optional(),
  kind: z.enum(['image', 'video']).optional(),
  favorite: z.enum(['1', 'true', '0', 'false']).optional(),
  q: z.string().max(200).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
})

const progressBody = z.object({
  positionMs: z.number().finite().min(0).max(86_400_000),
  durationMs: z.number().finite().min(0).max(86_400_000),
})

const reviewBody = z.object({
  rating: z.number().int().min(1).max(5),
  body: z.string().trim().min(1).max(4_000),
})

const relatedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(20).optional(),
})

export function registerAssetRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/assets', async (request, reply) => {
    const query = parseInput(assetQuery, request.query, reply)
    if (!query) return

    const cursor = query.cursor ? decodeCursor(query.cursor) : null
    if (query.cursor && !cursor) {
      reply.code(400).send({ error: 'invalid_cursor', message: 'The cursor is not valid.' })
      return
    }

    const filter: AssetFilter = {}
    if (query.libraryId) filter.libraryId = query.libraryId
    if (query.folderId) filter.folderId = query.folderId
    if (query.kind) filter.kind = query.kind
    if (query.favorite === '1' || query.favorite === 'true') filter.favoriteOnly = true
    if (query.q) filter.query = query.q

    const limit = query.limit ?? DEFAULT_PAGE_SIZE
    const { records, total, hasMore } = listAssets(ctx.db, request.user!.id, filter, cursor, limit)

    const now = Date.now()
    const missingPosters: AssetRecord[] = []
    for (const asset of records) {
      if (asset.kind !== 'video') continue
      const poster = thumbnailPath(ctx.config.cacheDir, asset.id, asset.fileVersion, 320)
      if (!(await fileExists(poster))) missingPosters.push(asset)
    }
    if (missingPosters.length > 0) {
      ctx.db.transaction(() => {
        for (const asset of missingPosters) {
          enqueueJob(
            ctx.db,
            {
              dedupeKey: `thumbnail:${asset.id}:${asset.fileVersion}`,
              kind: 'thumbnail',
              priority: PRIORITY.visible,
              assetId: asset.id,
            },
            now,
          )
        }
      })()
    }

    const last = records[records.length - 1]
    reply.send({
      items: records.map(toAssetDTO),
      total,
      nextCursor:
        hasMore && last ? encodeCursor({ takenAt: last.takenAt, id: last.id }) : null,
    })
  })

  app.get('/api/assets/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const asset = getAsset(ctx.db, request.user!.id, params.id)
    if (!asset) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    reply.send(toAssetDTO(asset))
  })

  app.post('/api/assets/:id/favorite', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    if (!getAssetFileInfo(ctx.db, params.id)) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    addFavorite(ctx.db, request.user!.id, params.id, Date.now())
    reply.code(204).send()
  })

  app.delete('/api/assets/:id/favorite', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    removeFavorite(ctx.db, request.user!.id, params.id)
    reply.code(204).send()
  })

  app.get('/api/assets/:id/review', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    if (!getAsset(ctx.db, request.user!.id, params.id)) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    const review = getReview(ctx.db, params.id, request.user!.id)
    reply.send({ review: review ? toReviewDTO(review) : null })
  })

  app.put('/api/assets/:id/review', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const body = parseInput(reviewBody, request.body, reply)
    if (!body) return
    if (!getAsset(ctx.db, request.user!.id, params.id)) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    const review = upsertReview(
      ctx.db,
      {
        id: newId(),
        assetId: params.id,
        userId: request.user!.id,
        rating: body.rating,
        body: body.body,
      },
      Date.now(),
    )
    reply.send(toReviewDTO(review))
  })

  app.delete('/api/assets/:id/review', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    deleteReview(ctx.db, params.id, request.user!.id)
    reply.code(204).send()
  })

  app.get('/api/assets/:id/related', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const query = parseInput(relatedQuery, request.query, reply)
    if (!query) return
    const asset = getAsset(ctx.db, request.user!.id, params.id)
    if (!asset) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }

    const limit = query.limit ?? 8
    // Meaning first: stored vectors rank by similarity, and the folder heuristic
    // stays as the answer until the worker has filled the table.
    const ranked = ctx.config.embedding.enabled
      ? relatedByEmbedding(
          ctx.db,
          request.user!.id,
          asset.id,
          asset.fileVersion,
          {
            modelSha256: ctx.config.embedding.modelSha256,
            pipelineVersion: ctx.config.embedding.pipelineVersion,
            dimensions: ctx.config.embedding.dimensions,
          },
          limit,
        )
      : []
    const basis = ranked.length > 0 ? 'semantic' : 'folder'
    const items =
      basis === 'semantic' ? ranked : relatedAssets(ctx.db, request.user!.id, params.id, limit)
    reply.send({ items: items.map(toAssetDTO), basis })
  })

  app.post('/api/assets/:id/embedding', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    if (!ctx.config.embedding.enabled) {
      reply.code(503).send({
        error: 'embedding_disabled',
        message: 'Video embeddings are not configured on this server.',
      })
      return
    }

    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null || info.kind !== 'video') {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }

    const job = enqueueEmbedding(ctx, info.id, info.fileVersion, Date.now())
    if (!job) {
      reply.code(409).send({ error: 'not_queued', message: 'The asset could not be queued.' })
      return
    }
    reply.code(202).send({ job: toEmbeddingJobDTO(job) })
  })

  app.get('/api/playback/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const progress = getProgress(ctx.db, request.user!.id, params.id)
    reply.send({ progress: progress ? toPlaybackDTO(progress) : null })
  })

  app.put('/api/playback/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const body = parseInput(progressBody, request.body, reply)
    if (!body) return
    if (!getAssetFileInfo(ctx.db, params.id)) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    const position = Math.min(body.positionMs, body.durationMs)
    putProgress(ctx.db, request.user!.id, params.id, Math.round(position), Math.round(body.durationMs), Date.now())
    reply.code(204).send()
  })
}
