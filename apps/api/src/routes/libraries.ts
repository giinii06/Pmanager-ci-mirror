import path from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  breadcrumb,
  getAlbumDeleteStatus,
  queueAlbumPhotoDeletion,
  createLibrary,
  deleteLibrary,
  enqueueJob,
  findPausedScanJob,
  getFolder,
  getLatestScanRun,
  getLibrary,
  getLibraryHealth,
  listAllFolders,
  listFolders,
  listLibraries,
  randomizeFolderCovers,
  listLibraryHealth,
  markLibraryFailure,
  markLibraryVerified,
  resumeJob,
  setFolderCover,
  setScanState,
  voteFolder,
} from '@mediavault/database'
import { resolveInside } from '@mediavault/media'
import { FOLDER_SORTS, PRIORITY, newId } from '@mediavault/shared'
import type { AppContext } from '../context'
import { toFolderDTO, toLibraryDTO, toLibraryHealthDetailDTO } from '../dto'
import { parseInput } from '../validate'
import { resolveSafeDirectory } from './fs'

const idParams = z.object({ id: z.string().min(1).max(64) })
const deleteKey = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/)

const createBody = z.object({
  name: z.string().trim().min(1, 'Name the library.').max(80),
  rootPath: z.string().trim().max(1024),
})

const folderQuery = z.object({
  libraryId: z.string().max(64).optional(),
  sort: z.enum(FOLDER_SORTS).optional(),
})

const folderCoverBody = z.object({
  assetId: z.string().min(1).max(64),
})

const voteBody = z.object({
  clientRequestId: z
    .string()
    .min(8)
    .max(100)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
})

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

function libraryHealthDetail(ctx: AppContext, libraryId: string) {
  return toLibraryHealthDetailDTO(
    libraryId,
    getLibraryHealth(ctx.db, libraryId),
    getLatestScanRun(ctx.db, libraryId),
  )
}

export function registerLibraryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/libraries', async (_request, reply) => {
    const health = new Map(listLibraryHealth(ctx.db).map((item) => [item.libraryId, item]))
    reply.send(listLibraries(ctx.db).map((library) => toLibraryDTO(library, health.get(library.id))))
  })

  app.post('/api/libraries', async (request, reply) => {
    const body = parseInput(createBody, request.body, reply)
    if (!body) return

    const mediaRoot = ctx.config.mediaRoot
    if (body.rootPath.includes('\0')) {
      reply.code(400).send({ error: 'invalid_path', message: 'Invalid directory path.' })
      return
    }
    const normalizedInput = body.rootPath.replace(/\\/g, '/')
    const requested =
      normalizedInput === ''
        ? mediaRoot
        : path.isAbsolute(normalizedInput)
          ? path.resolve(normalizedInput)
          : path.resolve(mediaRoot, normalizedInput)
    const relative = path.relative(mediaRoot, requested)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      reply.code(400).send({
        error: 'outside_media_root',
        message: `The folder must live under ${mediaRoot}.`,
      })
      return
    }

    const rootPath = relative === '' ? '' : toPosix(relative)
    const resolved = await resolveSafeDirectory(mediaRoot, rootPath)
    if ('error' in resolved) {
      reply.code(resolved.code).send({ error: resolved.error, message: resolved.message })
      return
    }

    for (const existing of listLibraries(ctx.db)) {
      if (existing.rootPath === rootPath) {
        reply.code(409).send({ error: 'already_registered', message: 'That folder is already a library.' })
        return
      }
      const existingAbs = resolveInside(mediaRoot, existing.rootPath)
      if (!existingAbs) continue
      const existingStat = await stat(existingAbs).catch(() => null)
      if (
        existingStat &&
        Number(existingStat.ino) > 0 &&
        Number(existingStat.dev) === Number(resolved.stats.dev) &&
        Number(existingStat.ino) === Number(resolved.stats.ino)
      ) {
        reply.code(409).send({
          error: 'already_registered',
          message: `That folder is already registered under "${existing.name}".`,
        })
        return
      }
    }

    const id = newId()
    const now = Date.now()
    createLibrary(ctx.db, { id, name: body.name, rootPath, createdAt: now })
    setScanState(ctx.db, id, 'queued')
    enqueueJob(
      ctx.db,
      {
        dedupeKey: `scan:${id}`,
        kind: 'scan_library',
        priority: PRIORITY.next,
        libraryId: id,
        requestId: request.id,
      },
      now,
    )
    const created = getLibrary(ctx.db, id)
    if (!created) {
      reply.code(500).send({ error: 'internal', message: 'Could not create the library.' })
      return
    }
    reply.code(201).send(toLibraryDTO(created, getLibraryHealth(ctx.db, created.id)))
  })

  app.get('/api/libraries/:id/health', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const library = getLibrary(ctx.db, params.id)
    if (!library) {
      reply.code(404).send({ error: 'not_found', message: 'Library not found.' })
      return
    }
    reply.send(libraryHealthDetail(ctx, library.id))
  })

  app.post('/api/libraries/:id/verify', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const library = getLibrary(ctx.db, params.id)
    if (!library) {
      reply.code(404).send({ error: 'not_found', message: 'Library not found.' })
      return
    }

    const resolved = await resolveSafeDirectory(ctx.config.mediaRoot, library.rootPath)
    if ('error' in resolved) {
      markLibraryFailure(ctx.db, {
        libraryId: library.id,
        state: 'OFFLINE',
        errorCode: resolved.error === 'not_found' ? 'root_missing' : resolved.error,
        now: Date.now(),
      })
      reply.send(libraryHealthDetail(ctx, library.id))
      return
    }

    let entries: string[]
    try {
      entries = await readdir(resolved.abs)
    } catch {
      markLibraryFailure(ctx.db, {
        libraryId: library.id,
        state: 'OFFLINE',
        errorCode: 'root_unreadable',
        now: Date.now(),
      })
      reply.send(libraryHealthDetail(ctx, library.id))
      return
    }

    if (entries.length === 0 && library.assetCount > 0) {
      markLibraryFailure(ctx.db, {
        libraryId: library.id,
        state: 'OFFLINE',
        errorCode: 'root_empty',
        now: Date.now(),
      })
    } else {
      markLibraryVerified(ctx.db, {
        libraryId: library.id,
        rootIdentity: `${resolved.stats.dev}:${resolved.stats.ino}`,
        now: Date.now(),
      })
    }

    reply.send(libraryHealthDetail(ctx, library.id))
  })

  app.post('/api/libraries/:id/scan', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const library = getLibrary(ctx.db, params.id)
    if (!library) {
      reply.code(404).send({ error: 'not_found', message: 'Library not found.' })
      return
    }
    const now = Date.now()
    const paused = findPausedScanJob(ctx.db, params.id)
    if (paused) {
      resumeJob(ctx.db, paused.id, now)
      setScanState(ctx.db, params.id, 'queued')
      reply.code(202).send({ ok: true })
      return
    }
    const state = enqueueJob(
      ctx.db,
      {
        dedupeKey: `scan:${params.id}`,
        kind: 'scan_library',
        priority: PRIORITY.next,
        libraryId: params.id,
        requestId: request.id,
      },
      now,
    )
    if (state === 'queued' && library.scanState === 'idle') setScanState(ctx.db, params.id, 'queued')
    reply.code(202).send({ ok: true })
  })

  app.delete('/api/libraries/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    if (!deleteLibrary(ctx.db, params.id)) {
      reply.code(404).send({ error: 'not_found', message: 'Library not found.' })
      return
    }
    reply.code(204).send()
  })

  app.get('/api/folders', async (request, reply) => {
    const query = parseInput(folderQuery, request.query, reply)
    if (!query) return
    const folders = query.libraryId
      ? listFolders(ctx.db, query.libraryId, query.sort)
      : listAllFolders(ctx.db, query.sort)
    reply.send(randomizeFolderCovers(ctx.db, folders).map(toFolderDTO))
  })

  app.get('/api/folders/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const folder = getFolder(ctx.db, params.id)
    if (!folder) {
      reply.code(404).send({ error: 'not_found', message: 'Folder not found.' })
      return
    }
    reply.send({ folder: toFolderDTO(folder), breadcrumb: breadcrumb(ctx.db, params.id).map(toFolderDTO) })
  })

  app.post('/api/folders/:id/delete-operations', async (request, reply) => {
    if (!ctx.config.fileMutationEnabled) {
      reply.code(503).send({ error: 'mutation_engine_disabled', message: '파일 삭제 기능이 비활성화되어 있습니다.' })
      return
    }
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const requestKey = request.headers['idempotency-key']
    const key = Array.isArray(requestKey) ? requestKey[0] : requestKey
    if (typeof key !== 'string' || !deleteKey.safeParse(key).success) {
      reply.code(400).send({ error: 'idempotency_key_required', message: '유효한 Idempotency-Key가 필요합니다.' })
      return
    }

    const folder = getFolder(ctx.db, params.id)
    if (!folder) {
      reply.code(404).send({ error: 'not_found', message: '앨범을 찾을 수 없습니다.' })
      return
    }
    const health = getLibraryHealth(ctx.db, folder.libraryId)
    if (!health || health.state !== 'ONLINE') {
      reply.code(409).send({ error: 'source_offline', message: '라이브러리가 온라인일 때만 영구 삭제할 수 있습니다.' })
      return
    }
    const result = queueAlbumPhotoDeletion(ctx.db, {
      folderId: folder.id,
      userId: request.user!.id,
      requestKey: `${request.user!.id}:album:${folder.id}:${key}`,
      now: Date.now(),
    })
    if (result.status !== 'ok') {
      const code = result.status === 'not_found' ? 404 : 409
      reply.code(code).send({
        error: `album_delete_${result.status}`,
        message: result.status === 'empty' ? '삭제할 사진이 없습니다.'
          : result.status === 'too_large' ? '한 번에 최대 10,000장의 사진을 삭제할 수 있습니다.'
          : '이미 삭제 작업이 진행 중이거나 앨범 상태가 변경되었습니다.',
      })
      return
    }
    reply.code(202).send(result.batch)
  })

  app.get('/api/album-delete-batches/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const status = getAlbumDeleteStatus(ctx.db, params.id, request.user!.id)
    if (!status) {
      reply.code(404).send({ error: 'not_found', message: '삭제 작업을 찾을 수 없습니다.' })
      return
    }
    reply.send(status)
  })

  app.post('/api/folders/:id/vote', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const body = parseInput(voteBody, request.body ?? {}, reply)
    if (!body) return
    const folder = voteFolder(
      ctx.db,
      params.id,
      Date.now(),
      body.clientRequestId,
      request.user!.id,
    )
    if (!folder) {
      reply.code(404).send({ error: 'not_found', message: 'Folder not found.' })
      return
    }
    reply.send(toFolderDTO(folder))
  })

  app.put('/api/folders/:id/cover', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const body = parseInput(folderCoverBody, request.body, reply)
    if (!body) return
    const result = setFolderCover(ctx.db, params.id, body.assetId)
    if (result.status === 'folder_not_found') {
      reply.code(404).send({ error: 'not_found', message: 'Folder not found.' })
      return
    }
    if (result.status === 'invalid_asset') {
      reply.code(400).send({
        error: 'invalid_cover_asset',
        message: '폴더 안에 있는 사진만 썸네일로 지정할 수 있습니다.',
      })
      return
    }
    reply.send(toFolderDTO(result.folder))
  })
}
