import path from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { enqueueJob, getAssetFileInfo, getLibrary, type AssetFileInfo, type LibraryRecord } from '@mediavault/database'
import { PRIORITY } from '@mediavault/shared'
import {
  cacheRelativePath,
  ensureImageThumbnail,
  ensurePreview,
  fileExists,
  hlsDir,
  hlsPlaylistPath,
  resolveInside,
  thumbnailPath,
} from '@mediavault/media'
import type { AppContext } from '../context'
import { accelPathFor, sendFile } from '../http'
import { parseInput } from '../validate'

const idParams = z.object({ id: z.string().min(1).max(64) })
const thumbnailQuery = z.object({ size: z.enum(['320', '640']).optional(), v: z.string().optional() })
const hlsParams = z.object({ id: z.string().min(1).max(64), file: z.string().min(1).max(64) })
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

    const target = thumbnailPath(ctx.config.cacheDir, info.id, info.fileVersion, size)
    if (!(await fileExists(target))) {
      if (info.kind === 'video') {
        enqueueJob(
          ctx.db,
          {
            dedupeKey: `thumbnail:${info.id}:${info.fileVersion}`,
            kind: 'thumbnail',
            priority: PRIORITY.now,
            assetId: info.id,
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
