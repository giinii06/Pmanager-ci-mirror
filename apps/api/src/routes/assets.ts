import { rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  addAssetWatchTime,
  addTagToAsset,
  bumpPosterVersion,
  commitPermanentDelete,
  createTag,
  deleteReview,
  enqueueJob,
  findTagByName,
  getAsset,
  getAssetDeletePlan,
  getAssetFileInfo,
  getLibrary,
  getProgress,
  getReview,
  getTag,
  incrementAssetView,
  listAssets,
  listMatchingAssetIds,
  putProgress,
  relatedAssets,
  relatedByEmbedding,
  removeTagFromAsset,
  resolveAssetSort,
  upsertReview,
  voteAsset,
  type AssetFilter,
  type AssetRecord,
} from '@mediavault/database'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, PRIORITY, VIDEO_SORTS, newId } from '@mediavault/shared'
import { extractCustomVideoPoster, fileExists, posterPath, resolveInside } from '@mediavault/media'
import type { AppContext } from '../context'
import { decodeCursor, encodeCursor } from '../cursor'
import { toAssetDTO, toEmbeddingJobDTO, toPlaybackDTO, toReviewDTO } from '../dto'
import { enqueueEmbedding } from '../embedding-trigger'
import { parseInput } from '../validate'

const idParams = z.object({ id: z.string().min(1).max(64) })
const tagParams = z.object({ id: z.string().min(1).max(64), tagId: z.string().min(1).max(64) })

const assetFilterQuery = z.object({
  libraryId: z.string().max(64).optional(),
  folderId: z.string().max(64).optional(),
  kind: z.enum(['image', 'video']).optional(),
  tagId: z.string().max(64).optional(),
  sort: z.enum(VIDEO_SORTS).optional(),
  seed: z.coerce.number().int().min(0).max(2_147_483_647).optional(),
  q: z.string().max(200).optional(),
})

const assetQuery = assetFilterQuery.extend({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
})

const idsQuery = assetFilterQuery.extend({
  limit: z.coerce.number().int().min(1).max(20_000).optional(),
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

const reviewBody = z.object({
  rating: z.number().int().min(1).max(5),
  body: z.string().trim().min(1).max(4_000),
})

const relatedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(20).optional(),
})

function toAssetFilter(query: z.infer<typeof assetFilterQuery>): AssetFilter {
  const filter: AssetFilter = {}
  if (query.libraryId) filter.libraryId = query.libraryId
  if (query.folderId) filter.folderId = query.folderId
  if (query.kind) filter.kind = query.kind
  if (query.tagId) filter.tagId = query.tagId
  if (query.sort) filter.sort = query.sort
  if (query.seed !== undefined) filter.seed = query.seed
  if (query.q) filter.query = query.q
  return filter
}

async function unlinkInside(baseDir: string, relative: string, strict: boolean): Promise<void> {
  const target = resolveInside(baseDir, relative)
  if (!target || path.resolve(target) === path.resolve(baseDir)) return
  try {
    await unlink(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    if (strict) throw error
    console.warn('[assets] cache unlink failed', { target, error })
  }
}

async function unlinkStrictMediaFile(baseDir: string, relative: string): Promise<void> {
  await unlinkInside(baseDir, relative, true)
}

async function unlinkIfInside(baseDir: string, relative: string): Promise<void> {
  await unlinkInside(baseDir, relative, false)
}

async function rmDirIfInside(baseDir: string, relative: string): Promise<void> {
  const target = resolveInside(baseDir, relative)
  if (!target || path.resolve(target) === path.resolve(baseDir)) return
  await rm(target, { recursive: true, force: true }).catch(() => undefined)
}

export function registerAssetRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/assets', async (request, reply) => {
    const query = parseInput(assetQuery, request.query, reply)
    if (!query) return

    const cursor = query.cursor ? decodeCursor(query.cursor) : null
    if (query.cursor && !cursor) {
      reply.code(400).send({ error: 'invalid_cursor', message: 'The cursor is not valid.' })
      return
    }

    const filter = toAssetFilter(query)
    const limit = query.limit ?? DEFAULT_PAGE_SIZE
    const { records, total, hasMore } = listAssets(ctx.db, filter, cursor, limit)

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
            },
            now,
          )
        }
      })()
    }

    const effectiveSort = resolveAssetSort(filter)
    const currentOffset = cursor && 'offset' in cursor ? cursor.offset : 0
    const last = records[records.length - 1]
    const nextCursor =
      hasMore && last
        ? effectiveSort === 'latest' && (!cursor || 'takenAt' in cursor)
          ? encodeCursor({ takenAt: last.takenAt, id: last.id })
          : encodeCursor({ offset: currentOffset + records.length })
        : null

    reply.send({
      items: records.map(toAssetDTO),
      total,
      nextCursor,
    })
  })

  app.get('/api/assets/ids', async (request, reply) => {
    const query = parseInput(idsQuery, request.query, reply)
    if (!query) return
    const ids = listMatchingAssetIds(ctx.db, toAssetFilter(query), query.limit ?? 10_000)
    reply.send({ ids })
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
    const updated = voteAsset(ctx.db, params.id)
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

    await extractCustomVideoPoster(
      source,
      ctx.config.cacheDir,
      info.id,
      info.fileVersion,
      body.positionMs,
    )
    const updated = bumpPosterVersion(ctx.db, info.id)
    if (!updated) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    reply.send({ asset: toAssetDTO(updated) })
  })

  app.delete('/api/assets/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return

    const res = getAssetDeletePlan(ctx.db, params.id)
    if (!res.deleted || !res.fileInfo) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }

    if (res.libraryRoot !== null) {
      const libRoot = resolveInside(ctx.config.mediaRoot, res.libraryRoot)
      if (libRoot) {
        try {
          await unlinkStrictMediaFile(libRoot, res.fileInfo.relativePath)
        } catch (error) {
          request.log.error({ err: error, assetId: params.id }, 'failed to unlink media file')
          reply
            .code(500)
            .send({ error: 'delete_failed', message: 'Failed to delete media file from disk.' })
          return
        }
      }
    }

    commitPermanentDelete(ctx.db, params.id, res.fileInfo.libraryId)

    await Promise.all([
      rmDirIfInside(ctx.config.cacheDir, path.join('thumbs', res.fileInfo.id)),
      rmDirIfInside(ctx.config.cacheDir, path.join('previews', res.fileInfo.id)),
      rmDirIfInside(ctx.config.cacheDir, path.join('hls', res.fileInfo.id)),
      ...res.sceneThumbPaths.map((rel) => unlinkIfInside(ctx.config.cacheDir, rel)),
      ...res.asrResultDirs.map((dir) =>
        rmDirIfInside(ctx.config.asr.resultDir, path.relative(ctx.config.asr.resultDir, dir)),
      ),
      ...res.translationResultDirs.map((dir) =>
        rmDirIfInside(
          ctx.config.translation.resultDir,
          path.relative(ctx.config.translation.resultDir, dir),
        ),
      ),
    ])

    reply.code(204).send()
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
    if (!getAssetFileInfo(ctx.db, params.id)) {
      reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
      return
    }
    const position = Math.min(body.positionMs, body.durationMs)
    putProgress(ctx.db, request.user!.id, params.id, Math.round(position), Math.round(body.durationMs), Date.now())
    reply.code(204).send()
  })
}
