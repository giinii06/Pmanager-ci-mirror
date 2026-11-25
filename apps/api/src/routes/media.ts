import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  createHlsRequest,
  enqueueJob,
  findPendingHlsGeneration,
  getAssetFileInfo,
  getHlsActive,
  getHlsGeneration,
  getLatestHlsGeneration,
  getLibrary,
  getLibraryHealth,
  touchHlsGenerationAccess,
  type AssetFileInfo,
  type HlsGenerationRecord,
  type LibraryRecord,
} from '@mediavault/database'
import { PRIORITY, timelinePreviewJobKey, timelinePreviewPageCount, type HlsStatusDTO } from '@mediavault/shared'
import {
  cacheRelativePath,
  ensureImageThumbnail,
  ensurePreview,
  fileExists,
  hlsDir,
  hlsPlaylistPath,
  hlsProfileHash,
  posterPath,
  resolveInside,
  thumbnailPath,
  timelinePreviewPath,
} from '@mediavault/media'
import type { AppContext } from '../context'
import { accelPathFor, sendFile } from '../http'
import { parseInput } from '../validate'

const idParams = z.object({ id: z.string().min(1).max(64) })
const thumbnailQuery = z.object({
  size: z.enum(['320', '640']).optional(),
  v: z.string().optional(),
  pv: z.string().optional(),
  p: z.string().optional(),
})
const hlsParams = z.object({ id: z.string().min(1).max(64), file: z.string().min(1).max(64) })
const hlsGenerationParams = z.object({
  id: z.string().min(1).max(64),
  generationId: z.string().regex(/^[a-z0-9]{6,32}$/),
  file: z.string().min(1).max(64),
})
const timelineParams = idParams.extend({ page: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
const timelineQuery = z.object({ v: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
const streamQuery = z.object({ v: z.string().optional(), download: z.enum(['0', '1']).optional() })

function resolveMedia(
  ctx: AppContext,
  info: AssetFileInfo,
): { source: string; library: LibraryRecord } | null {
  const library = getLibrary(ctx.db, info.libraryId)
  if (!library) return null
  const root = resolveInside(ctx.config.mediaRoot, library.rootPath)
  if (!root) return null
  const source = resolveInside(root, info.relativePath)
  if (!source) return null
  return { source, library }
}

function mediaRelativePath(library: LibraryRecord, info: AssetFileInfo): string {
  return library.rootPath === '' ? info.relativePath : `${library.rootPath}/${info.relativePath}`
}

function notFound(reply: FastifyReply): void {
  reply.code(404).send({ error: 'not_found', message: 'Asset not found.' })
}

function hlsPlaylistUrl(assetId: string, generationId: string): string {
  return `/api/assets/${assetId}/hls/g/${generationId}/master.m3u8`
}

function hlsSegmentUrl(assetId: string, generationId: string, file: string): string {
  return `/api/assets/${assetId}/hls/g/${generationId}/${file}`
}

function sendHlsStatus(reply: FastifyReply, code: number, body: HlsStatusDTO): void {
  reply.header('Cache-Control', 'no-store')
  if (code === 202) reply.header('Retry-After', String(body.retryAfterSeconds ?? 2))
  reply.code(code).send(body)
}

function generationStatus(generation: HlsGenerationRecord): HlsStatusDTO {
  const state: HlsStatusDTO['state'] =
    generation.state === 'running'
      ? 'running'
      : generation.state === 'retry_wait'
        ? 'retry_wait'
        : generation.state === 'failed' || generation.state === 'cancelled'
          ? generation.state
          : 'queued'
  return {
    state,
    generationId: generation.id,
    jobId: generation.jobId,
    stage: generation.stage,
    progressPercent: generation.progress,
    retryAfterSeconds: 2,
    errorCode: generation.errorCode,
    message: generation.errorMessage,
  }
}

function activeReadyGeneration(ctx: AppContext, info: AssetFileInfo): HlsGenerationRecord | null {
  const profileHash = hlsProfileHash({ width: info.width })
  const active = getHlsActive(ctx.db, info.id, info.fileVersion, profileHash)
  if (!active) return null
  const generation = getHlsGeneration(ctx.db, active.generationId)
  if (!generation || generation.state !== 'ready' || !generation.playlistRel) return null
  return generation
}

/**
 * A ready generation is served even when the library is offline; only a new
 * encode needs the source. Everything else reports its real state instead of
 * leaving the player on an endless `preparing` screen.
 */
function resolveHlsStatus(
  ctx: AppContext,
  info: AssetFileInfo,
): { code: number; body: HlsStatusDTO } {
  const ready = activeReadyGeneration(ctx, info)
  if (ready) {
    return {
      code: 200,
      body: {
        state: 'ready',
        generationId: ready.id,
        jobId: ready.jobId,
        progressPercent: 100,
        playlistUrl: hlsPlaylistUrl(info.id, ready.id),
      },
    }
  }

  const profileHash = hlsProfileHash({ width: info.width })
  const pending = findPendingHlsGeneration(ctx.db, info.id, info.fileVersion, profileHash)
  if (pending) return { code: 202, body: generationStatus(pending) }

  const latest = getLatestHlsGeneration(ctx.db, info.id, info.fileVersion, profileHash)
  if (latest && (latest.state === 'failed' || latest.state === 'cancelled')) {
    return {
      code: 200,
      body: {
        state: latest.state,
        generationId: latest.id,
        errorCode: latest.errorCode,
        message: latest.errorMessage,
      },
    }
  }

  const health = getLibraryHealth(ctx.db, info.libraryId)
  if (!health || health.state !== 'ONLINE') {
    return {
      code: 503,
      body: {
        state: 'source_offline',
        message: 'The library that holds this file is not online.',
      },
    }
  }

  const created = createHlsRequest(ctx.db, {
    assetId: info.id,
    fileVersion: info.fileVersion,
    profileHash,
    priority: PRIORITY.now,
    now: Date.now(),
  })
  return { code: 202, body: generationStatus(created.generation) }
}

export function registerMediaRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/assets/:id/thumbnail', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const query = parseInput(thumbnailQuery, request.query, reply)
    if (!query) return
    const size = Number(query.size ?? '640')

    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null) {
      notFound(reply)
      return
    }

    const target =
      info.kind === 'video'
        ? posterPath(ctx.config.cacheDir, info.id, info.fileVersion, size)
        : thumbnailPath(ctx.config.cacheDir, info.id, info.fileVersion, size)
    if (!(await fileExists(target))) {
      if (info.kind === 'video') {
        enqueueJob(
          ctx.db,
          {
            dedupeKey: `thumbnail:${info.id}:${info.fileVersion}`,
            kind: 'thumbnail',
            priority: PRIORITY.now,
            assetId: info.id,
            requestId: request.id,
          },
          Date.now(),
        )
        reply
          .header('Retry-After', '1')
          .header('Cache-Control', 'no-store')
          .code(404)
          .send({ error: 'preparing', message: 'The poster is being generated.' })
        return
      }

      const resolved = resolveMedia(ctx, info)
      if (!resolved) {
        notFound(reply)
        return
      }
      try {
        await ctx.thumbnails.run(() =>
          ensureImageThumbnail(
            resolved.source,
            ctx.config.cacheDir,
            info.id,
            info.fileVersion,
            size,
          ),
        )
      } catch (error) {
        request.log.warn({ err: error, assetId: info.id }, 'thumbnail generation failed')
        reply
          .header('Cache-Control', 'no-store')
          .code(415)
          .send({ error: 'unsupported_media', message: 'Could not read this image.' })
        return
      }
    }

    const accel = ctx.config.accel
      ? accelPathFor('/internal/cache', cacheRelativePath(ctx.config.cacheDir, target))
      : undefined
    await sendFile(request, reply, target, 'image/webp', {
      cacheControl: 'public, max-age=31536000, immutable',
      ...(accel ? { accelPath: accel } : {}),
    })
  })

  app.get('/api/assets/:id/timeline-preview/:page', async (request, reply) => {
    const params = parseInput(timelineParams, request.params, reply)
    if (!params) return
    const query = parseInput(timelineQuery, request.query, reply)
    if (!query) return

    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null || info.kind !== 'video' ||
        info.fileVersion !== query.v || params.page >= timelinePreviewPageCount(info.durationMs)) {
      reply.header('Cache-Control', 'no-store')
      notFound(reply)
      return
    }

    const target = timelinePreviewPath(ctx.config.cacheDir, info.id, info.fileVersion, params.page)
    if (!(await fileExists(target))) {
      const health = getLibraryHealth(ctx.db, info.libraryId)
      if (!resolveMedia(ctx, info) || health?.state !== 'ONLINE') {
        reply.header('Cache-Control', 'no-store').code(503).send({ error: 'source_offline' })
        return
      }
      const dedupeKey = timelinePreviewJobKey(info.id, info.fileVersion, params.page)
      const previous = ctx.db.query<{ state: string; updatedAt: number }, [string]>(
        'SELECT state, updated_at AS updatedAt FROM jobs WHERE dedupe_key = ? ORDER BY id DESC LIMIT 1',
      ).get(dedupeKey)
      if (previous?.state === 'failed' && Date.now() - previous.updatedAt < 60_000) {
        reply.header('Cache-Control', 'no-store').code(503).send({ error: 'preview_failed' })
        return
      }
      enqueueJob(ctx.db, {
        dedupeKey,
        kind: 'thumbnail',
        priority: PRIORITY.now,
        assetId: info.id,
        payload: { timelinePreviewPage: params.page, fileVersion: info.fileVersion },
        requestId: request.id,
      }, Date.now())
      reply.header('Retry-After', '3').header('Cache-Control', 'no-store')
        .code(202).send({ state: 'preparing' })
      return
    }

    const accel = ctx.config.accel
      ? accelPathFor('/internal/cache', cacheRelativePath(ctx.config.cacheDir, target))
      : undefined
    await sendFile(request, reply, target, 'image/webp', {
      cacheControl: 'private, max-age=31536000, immutable',
      ...(accel ? { accelPath: accel } : {}),
    })
  })

  app.get('/api/assets/:id/preview', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null || info.kind !== 'image') {
      notFound(reply)
      return
    }

    const resolved = resolveMedia(ctx, info)
    if (!resolved) {
      notFound(reply)
      return
    }

    let target: string
    try {
      target = await ctx.previews.run(() =>
        ensurePreview(resolved.source, ctx.config.cacheDir, info.id, info.fileVersion),
      )
    } catch (error) {
      request.log.warn({ err: error, assetId: info.id }, 'preview generation failed')
      reply
        .header('Cache-Control', 'no-store')
        .code(415)
        .send({ error: 'unsupported_media', message: 'Could not read this image.' })
      return
    }

    const accel = ctx.config.accel
      ? accelPathFor('/internal/cache', cacheRelativePath(ctx.config.cacheDir, target))
      : undefined
    await sendFile(request, reply, target, 'image/webp', {
      cacheControl: 'public, max-age=31536000, immutable',
      ...(accel ? { accelPath: accel } : {}),
    })
  })

  app.get('/api/assets/:id/stream', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const query = parseInput(streamQuery, request.query, reply)
    if (!query) return

    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null) {
      notFound(reply)
      return
    }
    const resolved = resolveMedia(ctx, info)
    if (!resolved) {
      notFound(reply)
      return
    }

    const accel = ctx.config.accel
      ? accelPathFor('/internal/media', mediaRelativePath(resolved.library, info))
      : undefined
    const disposition =
      query.download === '1'
        ? `attachment; filename*=UTF-8''${encodeURIComponent(info.filename)}`
        : undefined

    await sendFile(request, reply, resolved.source, info.mimeType, {
      cacheControl: 'private, max-age=3600',
      ...(accel ? { accelPath: accel } : {}),
      ...(disposition ? { contentDisposition: disposition } : {}),
    })
  })

  app.get('/api/assets/:id/hls', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null) {
      notFound(reply)
      return
    }

    if (!ctx.config.hlsGenerationsEnabled) {
      const playlist = hlsPlaylistPath(ctx.config.cacheDir, info.id, info.fileVersion)
      if (await fileExists(playlist)) {
        reply.send({
          state: 'ready',
          playlistUrl: `/api/assets/${info.id}/hls/master.m3u8`,
          progressPercent: 100,
        })
        return
      }
      enqueueJob(
        ctx.db,
        {
          dedupeKey: `hls:${info.id}:${info.fileVersion}`,
          kind: 'hls',
          priority: PRIORITY.now,
          assetId: info.id,
          requestId: request.id,
        },
        Date.now(),
      )
      sendHlsStatus(reply, 202, { state: 'queued', retryAfterSeconds: 2 })
      return
    }

    const status = resolveHlsStatus(ctx, info)
    sendHlsStatus(reply, status.code, status.body)
  })

  app.post('/api/assets/:id/hls/retry', async (request, reply) => {
    if (!ctx.config.hlsGenerationsEnabled) {
      reply.code(404).send({ error: 'not_found', message: 'HLS generations are disabled.' })
      return
    }
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null) {
      notFound(reply)
      return
    }

    const profileHash = hlsProfileHash({ width: info.width })
    const active = getHlsActive(ctx.db, info.id, info.fileVersion, profileHash)
    const activeGeneration = active ? getHlsGeneration(ctx.db, active.generationId) : null
    if (activeGeneration?.state === 'ready' && activeGeneration.playlistRel) {
      sendHlsStatus(reply, 200, {
        state: 'ready',
        generationId: activeGeneration.id,
        progressPercent: 100,
        playlistUrl: hlsPlaylistUrl(info.id, activeGeneration.id),
      })
      return
    }

    const health = getLibraryHealth(ctx.db, info.libraryId)
    if (!health || health.state !== 'ONLINE') {
      sendHlsStatus(reply, 503, {
        state: 'source_offline',
        message: 'The library that holds this file is not online.',
      })
      return
    }

    const created = createHlsRequest(ctx.db, {
      assetId: info.id,
      fileVersion: info.fileVersion,
      profileHash,
      priority: PRIORITY.now,
      now: Date.now(),
    })
    sendHlsStatus(reply, 202, generationStatus(created.generation))
  })

  app.get('/api/assets/:id/hls/g/:generationId/:file', async (request, reply) => {
    if (!ctx.config.hlsGenerationsEnabled) {
      notFound(reply)
      return
    }
    const params = parseInput(hlsGenerationParams, request.params, reply)
    if (!params) return
    if (!/^(master\.m3u8|seg\d{5}\.ts)$/.test(params.file)) {
      notFound(reply)
      return
    }

    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null) {
      notFound(reply)
      return
    }
    const generation = getHlsGeneration(ctx.db, params.generationId)
    if (
      !generation ||
      generation.assetId !== info.id ||
      generation.state !== 'ready' ||
      !generation.storageRel
    ) {
      notFound(reply)
      return
    }

    const generationDir = resolveInside(ctx.config.cacheDir, generation.storageRel)
    const target = generationDir ? resolveInside(generationDir, params.file) : null
    if (!target || !(await fileExists(target))) {
      notFound(reply)
      return
    }

    touchHlsGenerationAccess(ctx.db, generation.id, Date.now())
    const contentType =
      params.file === 'master.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp2t'
    const accel = ctx.config.accel
      ? accelPathFor('/internal/cache', cacheRelativePath(ctx.config.cacheDir, target))
      : undefined
    await sendFile(request, reply, target, contentType, {
      cacheControl: 'private, max-age=31536000, immutable',
      ...(accel ? { accelPath: accel } : {}),
    })
  })

  app.get('/api/assets/:id/hls/:file', async (request, reply) => {
    const params = parseInput(hlsParams, request.params, reply)
    if (!params) return
    if (!/^(master\.m3u8|seg\d{5}\.ts)$/.test(params.file)) {
      notFound(reply)
      return
    }

    const info = getAssetFileInfo(ctx.db, params.id)
    if (!info || info.deletedAt !== null) {
      notFound(reply)
      return
    }

    if (ctx.config.hlsGenerationsEnabled) {
      const generation = activeReadyGeneration(ctx, info)
      if (generation) {
        if (params.file === 'master.m3u8') {
          const playlist = generation.playlistRel
            ? resolveInside(ctx.config.cacheDir, generation.playlistRel)
            : null
          if (!playlist || !(await fileExists(playlist))) {
            notFound(reply)
            return
          }
          const text = await readFile(playlist, 'utf8')
          const pinned = text
            .split('\n')
            .map((line) => {
              const trimmed = line.trim()
              if (trimmed === '' || trimmed.startsWith('#')) return line
              return hlsSegmentUrl(info.id, generation.id, trimmed)
            })
            .join('\n')
          reply
            .header('Cache-Control', 'no-cache')
            .type('application/vnd.apple.mpegurl')
            .send(pinned)
          return
        }
        reply.redirect(hlsSegmentUrl(info.id, generation.id, params.file), 302)
        return
      }

      if (params.file !== 'master.m3u8') {
        notFound(reply)
        return
      }
      const status = resolveHlsStatus(ctx, info)
      sendHlsStatus(reply, status.code, status.body)
      return
    }

    const playlist = hlsPlaylistPath(ctx.config.cacheDir, info.id, info.fileVersion)
    const target =
      params.file === 'master.m3u8'
        ? playlist
        : path.join(hlsDir(ctx.config.cacheDir, info.id, info.fileVersion), params.file)

    if (!(await fileExists(target))) {
      if (params.file === 'master.m3u8') {
        enqueueJob(
          ctx.db,
          {
            dedupeKey: `hls:${info.id}:${info.fileVersion}`,
            kind: 'hls',
            priority: PRIORITY.now,
            assetId: info.id,
          },
          Date.now(),
        )
        reply
          .header('Retry-After', '2')
          .header('Cache-Control', 'no-store')
          .code(202)
          .send({ state: 'preparing' })
        return
      }
      notFound(reply)
      return
    }

    const contentType =
      params.file === 'master.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp2t'
    const accel = ctx.config.accel
      ? accelPathFor('/internal/cache', cacheRelativePath(ctx.config.cacheDir, target))
      : undefined
    await sendFile(request, reply, target, contentType, {
      cacheControl: 'no-cache',
      ...(accel ? { accelPath: accel } : {}),
    })
  })
}
