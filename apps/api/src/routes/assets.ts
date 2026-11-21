import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  addAssetWatchTime,
  addTagToAsset,
  bumpPosterVersion,
  createDeleteMutation,
  createTag,
  deleteReview,
  enqueueJob,
  findTagByName,
  getAsset,
  getAssetFileInfo,
  getAssetNeighbor,
  getLibrary,
  getLibraryHealth,
  getMutationAsset,
  getProgress,
  getReview,
  getTag,
  incrementAssetView,
  listMatchingAssetIds,
  pickRandomAsset,
  putProgress,
  relatedAssets,
  relatedByEmbedding,
  removeTagFromAsset,
  upsertReview,
  voteAsset,
  type AssetFilter,
  type AssetRecord,
} from '@mediavault/database'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, PRIORITY, newId } from '@mediavault/shared'
import {
  PosterPublishRefusedError,
  extractCustomVideoPoster,
  fileExists,
  posterPath,
  resolveInside,
} from '@mediavault/media'
import { readAssetPage } from '../asset-page'
import { assetFilterQuery, toAssetFilter } from '../asset-filter'
import type { AppContext } from '../context'
import { toAssetDTO, toEmbeddingJobDTO, toFileOperationDTO, toPlaybackDTO, toReviewDTO } from '../dto'
import { enqueueEmbedding } from '../embedding-trigger'
import { parseInput } from '../validate'

const idParams = z.object({ id: z.string().min(1).max(64) })
const tagParams = z.object({ id: z.string().min(1).max(64), tagId: z.string().min(1).max(64) })

const assetQuery = assetFilterQuery.extend({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
})

const idsQuery = assetFilterQuery.extend({
  limit: z.coerce.number().int().min(1).max(20_000).optional(),
})

const neighborQuery = assetFilterQuery.extend({
  direction: z.enum(['next', 'prev']),
})

const randomBody = z.object({
  libraryId: z.string().max(64).optional(),
  folderId: z.string().max(64).optional(),
  kind: z.enum(['image', 'video']).optional(),
  tagId: z.string().max(64).optional(),
  q: z.string().max(200).optional(),
  currentAssetId: z.string().min(1).max(64).optional(),
  recentIds: z.array(z.string().min(1).max(64)).max(50).optional(),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
})

const watchTimeBody = z.object({
  deltaMs: z.number().finite().min(1).max(600_000),
})

const thumbnailCaptureBody = z.object({
  positionMs: z.number().finite().min(0).max(86_400_000),
})

const attachTagBody = z
  .object({
    tagId: z.string().min(1).max(64).optional(),
    name: z.string().trim().min(1).max(60).optional(),
  })
  .refine((data) => Boolean(data.tagId || data.name), {
    message: 'tagId 또는 name이 필요합니다.',
  })

const progressBody = z.object({
  positionMs: z.number().finite().min(0).max(86_400_000),
  durationMs: z.number().finite().min(0).max(86_400_000),
})

const voteBody = z.object({
  clientRequestId: z
    .string()
    .min(8)
    .max(100)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
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

    const filter = toAssetFilter(query)

    const page = readAssetPage(ctx.db, filter, query.cursor ?? null, query.limit ?? DEFAULT_PAGE_SIZE)
    if (page.kind === 'invalid_cursor') {
      reply.code(400).send({ error: 'invalid_cursor', message: 'The cursor is not valid.' })
      return
    }
    const { records, total, nextCursor } = page.page

    const now = Date.now()
    const missingPosters: AssetRecord[] = []
    for (const asset of records) {
      if (asset.kind !== 'video') continue
      const poster = posterPath(ctx.config.cacheDir, asset.id, asset.fileVersion, 320)
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
              requestId: request.id,
            },
            now,
          )
        }
      })()
    }

    reply.send({
      items: records.map(toAssetDTO),
      total,
      nextCursor,
    })
  })

  app.get('/api/assets/ids', async (request, reply) => {
    const query = parseInput(idsQuery, request.query, reply)
    if (!query) return
    const filter = toAssetFilter(query)
    reply.send({ ids: listMatchingAssetIds(ctx.db, filter, query.limit ?? 10_000) })
  })

  app.post('/api/assets/random', async (request, reply) => {
    const body = parseInput(randomBody, request.body ?? {}, reply)
    if (!body) return
    const filter: AssetFilter = {}
    if (body.libraryId) filter.libraryId = body.libraryId
    if (body.folderId) filter.folderId = body.folderId
    if (body.kind) filter.kind = body.kind
    if (body.tagId) filter.tagId = body.tagId
    if (body.q) filter.query = body.q
    const asset = pickRandomAsset(ctx.db, filter, {
      currentAssetId: body.currentAssetId ?? null,
      recentIds: body.recentIds ?? [],
      seed: body.seed,
    })
    if (!asset) {
      reply.code(204).send()
      return
    }
    reply.send({ asset: toAssetDTO(asset) })
  })

  app.get('/api/assets/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const asset = getAsset(ctx.db, params.id)
    if (!asset) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    reply.send(toAssetDTO(asset))
  })

  app.get('/api/assets/:id/neighbor', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const query = parseInput(neighborQuery, request.query, reply)
    if (!query) return
    const filter = toAssetFilter(query)
    const result = getAssetNeighbor(ctx.db, params.id, filter, query.direction)
    if (result.kind === 'missing') {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    if (result.kind === 'outside_filter') {
      reply
        .code(409)
        .send({ error: 'anchor_not_in_filter', message: 'The asset is not part of this filter.' })
      return
    }
    if (!result.record) {
      reply.code(204).send()
      return
    }
    reply.send({ asset: toAssetDTO(result.record) })
  })

  app.post('/api/assets/:id/view', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const updated = incrementAssetView(ctx.db, params.id)
    if (!updated) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    reply.send(toAssetDTO(updated))
  })

  app.post('/api/assets/:id/watch-time', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const body = parseInput(watchTimeBody, request.body, reply)
    if (!body) return
    const updated = addAssetWatchTime(ctx.db, params.id, body.deltaMs)
    if (!updated) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    reply.send(toAssetDTO(updated))
  })

  app.post('/api/assets/:id/vote', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const body = parseInput(voteBody, request.body ?? {}, reply)
    if (!body) return
    const updated = voteAsset(
      ctx.db,
      params.id,
      Date.now(),
      body.clientRequestId,
      request.user!.id,
    )
    if (!updated) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    reply.send(toAssetDTO(updated))
  })

  app.post('/api/assets/:id/thumbnail', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const body = parseInput(thumbnailCaptureBody, request.body, reply)
    if (!body) return

    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null || info.kind !== 'video') {
      reply.code(404).send({ error: 'not_found', message: 'Video asset not found.' })
      return
    }
    const library = getLibrary(ctx.db, info.libraryId)
    const root = library ? resolveInside(ctx.config.mediaRoot, library.rootPath) : null
    const source = root ? resolveInside(root, info.relativePath) : null
    if (!source) {
      reply.code(404).send({ error: 'not_found', message: 'Media file not found on disk.' })
      return
    }

    const canPublish = () => {
      const fresh = getAssetFileInfo(ctx.db, info.id)
      return Boolean(fresh && fresh.deletedAt === null && fresh.fileVersion === info.fileVersion)
    }

    try {
      await extractCustomVideoPoster(
        source,
        ctx.config.cacheDir,
        info.id,
        info.fileVersion,
        body.positionMs,
        { canPublish },
      )
    } catch (error) {
      if (error instanceof PosterPublishRefusedError) {
        reply.code(409).send({
          error: 'file_changed',
          message: 'The file changed while the frame was captured. Try again.',
        })
        return
      }
      request.log.warn({ err: error, assetId: info.id }, 'poster capture failed')
      reply.code(422).send({
        error: 'poster_capture_failed',
        message: 'Could not read a frame at that position.',
      })
      return
    }

    const updated = bumpPosterVersion(ctx.db, info.id, info.fileVersion)
    if (!updated) {
      const current = getAssetFileInfo(ctx.db, info.id)
      if (!current || current.deletedAt !== null) {
        reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      } else {
        reply.code(409).send({
          error: 'file_changed',
          message: 'The file changed while the frame was captured. Try again.',
        })
      }
      return
    }
    reply.send({ asset: toAssetDTO(updated) })
  })

  // Compatibility shim for clients that still call DELETE. It never touches the
  // file itself: the mutation worker owns every original-file change.
  app.delete('/api/assets/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return

    if (!ctx.config.fileMutationEnabled) {
      reply
        .code(503)
        .send({ error: 'mutation_engine_disabled', message: 'The delete engine is turned off.' })
      return
    }

    const asset = getMutationAsset(ctx.db, params.id)
    if (!asset || asset.deletedAt !== null) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    const health = getLibraryHealth(ctx.db, asset.libraryId)
    if (!health || health.state !== 'ONLINE') {
      reply
        .code(409)
        .send({ error: 'source_offline', message: 'The library that holds this file is not online.' })
      return
    }

    const result = createDeleteMutation(ctx.db, {
      assetId: asset.id,
      libraryId: asset.libraryId,
      userId: request.user!.id,
      requestKey: `${request.user!.id}:legacy-delete:${asset.id}`,
      requestedFileVersion: asset.fileVersion,
      sourceRel: asset.relativePath,
      now: Date.now(),
    })
    reply.code(202).send(toFileOperationDTO(result.record))
  })

  app.post('/api/assets/:id/tags', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const body = parseInput(attachTagBody, request.body, reply)
    if (!body) return

    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }

    const now = Date.now()
    let tagId = body.tagId
    if (tagId) {
      if (!getTag(ctx.db, tagId)) {
        reply.code(404).send({ error: 'tag_not_found', message: 'Tag not found.' })
        return
      }
    } else if (body.name) {
      const existing = findTagByName(ctx.db, body.name)
      const tag = existing ?? createTag(ctx.db, newId(), body.name, now)
      tagId = tag.id
    }

    if (tagId) addTagToAsset(ctx.db, params.id, tagId, now)
    const updated = getAsset(ctx.db, params.id)
    if (!updated) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    reply.send({ asset: toAssetDTO(updated) })
  })

  app.delete('/api/assets/:id/tags/:tagId', async (request, reply) => {
    const params = parseInput(tagParams, request.params, reply)
    if (!params) return
    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    removeTagFromAsset(ctx.db, params.id, params.tagId)
    const updated = getAsset(ctx.db, params.id)
    if (!updated) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    reply.send({ asset: toAssetDTO(updated) })
  })

  app.get('/api/assets/:id/review', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    if (!getAsset(ctx.db, params.id)) {
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
    if (!getAsset(ctx.db, params.id)) {
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
    const asset = getAsset(ctx.db, params.id)
    if (!asset) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }

    const limit = query.limit ?? 8
    const ranked = ctx.config.embedding.enabled
      ? relatedByEmbedding(
          ctx.db,
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
    const items = basis === 'semantic' ? ranked : relatedAssets(ctx.db, params.id, limit)
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
    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    const position = Math.min(body.positionMs, body.durationMs)
    putProgress(
      ctx.db,
      request.user!.id,
      params.id,
      Math.round(position),
      Math.round(body.durationMs),
      Date.now(),
      info.fileVersion,
    )
    reply.code(204).send()
  })
}
