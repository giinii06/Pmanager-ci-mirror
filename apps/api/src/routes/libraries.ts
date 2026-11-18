import path from 'node:path'
import { stat } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  breadcrumb,
  createLibrary,
  deleteLibrary,
  enqueueJob,
  findLibraryByRoot,
  getFolder,
  getLibrary,
  listAllFolders,
  listFolders,
  listLibraries,
  setScanState,
  voteFolder,
} from '@mediavault/database'
import { FOLDER_SORTS, PRIORITY, newId } from '@mediavault/shared'
import type { AppContext } from '../context'
import { toFolderDTO, toLibraryDTO } from '../dto'
import { parseInput } from '../validate'

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
    const requested =
      body.rootPath === ''
        ? mediaRoot
        : path.isAbsolute(body.rootPath)
          ? path.resolve(body.rootPath)
          : path.resolve(mediaRoot, body.rootPath)
    const relative = path.relative(mediaRoot, requested)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      reply.code(400).send({
        error: 'outside_media_root',
        message: `The folder must live under ${mediaRoot}.`,
      })
      return
    }

    const info = await stat(requested).catch(() => null)
    if (!info?.isDirectory()) {
      reply.code(400).send({ error: 'not_a_directory', message: 'That folder does not exist.' })
      return
    }

    const rootPath = relative === '' ? '' : toPosix(relative)
    if (findLibraryByRoot(ctx.db, rootPath)) {
      reply.code(409).send({ error: 'already_registered', message: 'That folder is already a library.' })
      return
    }

    const id = newId()
    createLibrary(ctx.db, { id, name: body.name, rootPath, createdAt: Date.now() })
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
    if (library.scanState === 'idle') setScanState(ctx.db, params.id, 'queued')
    enqueueJob(
      ctx.db,
      {
        dedupeKey: `scan:${params.id}`,
        kind: 'scan_library',
        priority: PRIORITY.next,
        libraryId: params.id,
      },
      Date.now(),
    )
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
