import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  countPeople,
  getDetection,
  getPerson,
  listPeople,
  mergePeople,
  personAssets,
  personFaces,
  reclusterUnassigned,
  renamePerson,
  setPersonState,
  splitPerson,
  type PersonRecord,
} from '@mediavault/database'
import type { PersonDTO } from '@mediavault/shared'
import type { AppContext } from '../context'
import { accelPathFor, sendFile } from '../http'
import { parseInput } from '../validate'

const idParams = z.object({ id: z.string().min(1).max(64) })
const listQuery = z.object({
  state: z.enum(['approved', 'candidate', 'excluded', 'all']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})
const renameBody = z.object({ name: z.string().trim().min(1).max(60) })
const mergeBody = z.object({ sourceId: z.string().min(1).max(64) })
const splitBody = z.object({
  detectionIds: z.array(z.string().min(1).max(64)).min(1).max(200),
  name: z.string().trim().min(1).max(60).optional(),
})

function toDTO(db: Parameters<typeof personAssets>[0], person: PersonRecord): PersonDTO {
  const assets = personAssets(db, person.id)
  return {
    id: person.id,
    name: person.name,
    state: person.state,
    faceCount: person.faceCount,
    assetCount: assets.length,
    coverUrl: person.coverDetectionId ? `/api/faces/${person.coverDetectionId}/thumbnail` : null,
    createdAt: new Date(person.createdAt).toISOString(),
    updatedAt: new Date(person.updatedAt).toISOString(),
  }
}

export function registerPeopleRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/people', async (request, reply) => {
    const query = parseInput(listQuery, request.query, reply)
    if (!query) return

    const state = query.state ?? 'approved'
    const people = listPeople(ctx.db, state, query.limit ?? 100)
    reply.send({
      people: people.map((person) => toDTO(ctx.db, person)),
      counts: {
        approved: countPeople(ctx.db, 'approved'),
        candidate: countPeople(ctx.db, 'candidate'),
        excluded: countPeople(ctx.db, 'excluded'),
      },
    })
  })

  app.get('/api/people/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return

    const person = getPerson(ctx.db, params.id)
    if (!person) {
      reply.code(404).send({ error: 'not_found', message: 'Person not found.' })
      return
    }
    const faces = personFaces(ctx.db, person.id, 60).map((face) => ({
      detectionId: face.detectionId,
      assetId: face.assetId,
      filename: face.filename,
      frameMs: face.frameMs,
      url: `/api/faces/${face.detectionId}/thumbnail`,
    }))
    reply.send({ person: toDTO(ctx.db, person), faces })
  })

  app.get('/api/people/:id/assets', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const person = getPerson(ctx.db, params.id)
    if (!person) {
      reply.code(404).send({ error: 'not_found', message: 'Person not found.' })
      return
    }
    reply.send({
      assets: personAssets(ctx.db, person.id).map((asset) => ({
        assetId: asset.assetId,
        filename: asset.filename,
        durationMs: asset.durationMs,
        faceCount: asset.faceCount,
        bestDetectionId: asset.bestDetectionId,
        thumbnailUrl: asset.bestDetectionId
          ? `/api/faces/${asset.bestDetectionId}/thumbnail`
          : `/api/assets/${asset.assetId}/thumbnail`,
      })),
    })
  })

  app.post('/api/people/:id/approve', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const person = setPersonState(ctx.db, params.id, 'approved', request.user?.id ?? null, Date.now())
    if (!person) {
      reply.code(404).send({ error: 'not_found', message: 'Person not found.' })
      return
    }
    reply.send({ person: toDTO(ctx.db, person) })
  })

  app.post('/api/people/:id/exclude', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const person = setPersonState(ctx.db, params.id, 'excluded', request.user?.id ?? null, Date.now())
    if (!person) {
      reply.code(404).send({ error: 'not_found', message: 'Person not found.' })
      return
    }
    reply.send({ person: toDTO(ctx.db, person) })
  })

  app.post('/api/people/:id/rename', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const body = parseInput(renameBody, request.body ?? {}, reply)
    if (!body) return
    const person = renamePerson(ctx.db, params.id, body.name, request.user?.id ?? null, Date.now())
    if (!person) {
      reply.code(404).send({ error: 'not_found', message: 'Person not found.' })
      return
    }
    reply.send({ person: toDTO(ctx.db, person) })
  })

  app.post('/api/people/:id/merge', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const body = parseInput(mergeBody, request.body ?? {}, reply)
    if (!body) return
    const person = mergePeople(ctx.db, body.sourceId, params.id, request.user?.id ?? null, Date.now())
    if (!person) {
      reply.code(404).send({ error: 'not_found', message: 'Person not found.' })
      return
    }
    reply.send({ person: toDTO(ctx.db, person) })
  })

  app.post('/api/people/:id/split', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const body = parseInput(splitBody, request.body ?? {}, reply)
    if (!body) return

    const person = getPerson(ctx.db, params.id)
    if (!person) {
      reply.code(404).send({ error: 'not_found', message: 'Person not found.' })
      return
    }
    const created = splitPerson(
      ctx.db,
      params.id,
      body.detectionIds,
      body.name ?? `${person.name} (분리)`,
      request.user?.id ?? null,
      Date.now(),
    )
    if (!created) {
      reply
        .code(422)
        .send({ error: 'invalid_split', message: 'Pick some faces, but not every face.' })
      return
    }
    reply.send({ person: toDTO(ctx.db, created) })
  })

  app.post('/api/people/rescan', async (request, reply) => {
    if (!ctx.config.face.enabled) {
      reply.code(409).send({ error: 'disabled', message: 'Face recognition is not configured.' })
      return
    }
    const dropped = reclusterUnassigned(
      ctx.db,
      ctx.config.face.matchThreshold,
      ctx.config.face.candidateThreshold,
      request.user?.id ?? null,
      Date.now(),
    )
    reply.send({ dropped, counts: { candidate: countPeople(ctx.db, 'candidate') } })
  })

  app.get('/api/faces/:id/thumbnail', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return

    const detection = getDetection(ctx.db, params.id)
    if (!detection) {
      reply.code(404).send({ error: 'not_found', message: 'Face not found.' })
      return
    }
    if (!detection.thumbnailPath) {
      reply.code(404).send({ error: 'not_found', message: 'Face thumbnail is missing.' })
      return
    }

    const target = path.join(ctx.config.cacheDir, detection.thumbnailPath)
    const accel = ctx.config.accel
      ? accelPathFor('/internal/cache', detection.thumbnailPath)
      : undefined
    await sendFile(request, reply, target, 'image/jpeg', {
      cacheControl: 'public, max-age=31536000, immutable',
      ...(accel ? { accelPath: accel } : {}),
    })
  })
}
