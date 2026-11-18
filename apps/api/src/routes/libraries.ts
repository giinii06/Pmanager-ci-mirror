import path from 'node:path'
import { stat } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  breadcrumb,
  createLibrary,
  deleteLibrary,
  enqueueJob,
  findPausedScanJob,
  getFolder,
  getLibrary,
  listAllFolders,
  listFolders,
  listLibraries,
  resumeJob,
  setScanState,
  voteFolder,
} from '@mediavault/database'
import { resolveInside } from '@mediavault/media'
import { FOLDER_SORTS, PRIORITY, newId } from '@mediavault/shared'
import type { AppContext } from '../context'
import { toFolderDTO, toLibraryDTO } from '../dto'
import { parseInput } from '../validate'
import { resolveSafeDirectory } from './fs'

const idParams = z.object({ id: z.string().min(1).max(64) })

const createBody = z.object({
  name: z.string().trim().min(1, 'Name the library.').max(80),
  rootPath: z.string().trim().max(1024),
})

const folderQuery = z.object({
  libraryId: z.string().max(64).optional(),
  sort: z.enum(FOLDER_SORTS).optional(),
})

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

export function registerLibraryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/libraries', async (_request, reply) => {
    reply.send(listLibraries(ctx.db).map(toLibraryDTO))
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
      },
      now,
    )
    const created = getLibrary(ctx.db, id)
    if (!created) {
      reply.code(500).send({ error: 'internal', message: 'Could not create the library.' })
      return
    }
    reply.code(201).send(toLibraryDTO(created))
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
    reply.send(folders.map(toFolderDTO))
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

  app.post('/api/folders/:id/vote', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const folder = voteFolder(ctx.db, params.id)
    if (!folder) {
      reply.code(404).send({ error: 'not_found', message: 'Folder not found.' })
      return
    }
    reply.send(toFolderDTO(folder))
  })
}
