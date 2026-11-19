import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  countMatchingAssets,
  countTargetCollisions,
  createBulkOperation,
  createTag,
  findTagByName,
  getBulkOperation,
  getBulkOperationByRequestKey,
  getBulkOperationCounts,
  getBulkOperationErrorGroups,
  getLibrary,
  getLibraryHealth,
  getTag,
  listBulkOperationItems,
  listBulkOperations,
  listMatchingAssetRows,
  requestBulkCancel,
  retryBulkItems,
  selectionAssetsByIds,
  type BulkSelectionItem,
  type Db,
  type SelectionAssetRow,
} from '@mediavault/database'
import { AI_STAGES, newId } from '@mediavault/shared'
import { applyAlbum, assetFilterQuery, toAssetFilter } from '../asset-filter'
import type { AppContext } from '../context'
import { toBulkOperationDTO, toBulkOperationDetailDTO, toBulkOperationItemDTO } from '../dto'
import { joinTargetPath, normalizeTargetFolder } from '../target-path'
import { parseInput } from '../validate'

const MAX_ITEMS = 10_000
const SAMPLE_SIZE = 5
const COLLISION_CHUNK = 400

const BULK_KINDS = [
  'tag_add',
  'tag_remove',
  'reanalyze',
  'poster',
  'move',
  'copy',
  'delete',
  'export',
] as const

const idParams = z.object({ id: z.string().min(1).max(64) })

const selectionBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ids'),
    assetIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_ITEMS),
  }),
  z.object({ kind: z.literal('query'), query: assetFilterQuery }),
])

const paramsBody = z.object({
  tagId: z.string().min(1).max(64).optional(),
  tagName: z.string().trim().min(1).max(60).optional(),
  targetLibraryId: z.string().min(1).max(64).optional(),
  targetFolder: z.string().max(1_024).optional(),
  stages: z.array(z.enum(AI_STAGES)).min(1).max(4).optional(),
  confirm: z.literal('delete').optional(),
})

const previewBody = z.object({
  kind: z.enum(BULK_KINDS),
  selection: selectionBody,
  params: paramsBody.optional(),
})

const createBody = previewBody.extend({
  requestId: z
    .string()
    .min(8)
    .max(100)
    .regex(/^[A-Za-z0-9_-]+$/),
  generation: z.string().min(1).max(2_000),
  expectedCount: z.number().int().min(0).max(10_000_000),
})

const detailQuery = z.object({
  itemState: z.enum(['pending', 'running', 'succeeded', 'failed', 'held', 'cancelled']).optional(),
  itemLimit: z.coerce.number().int().min(1).max(500).optional(),
  itemOffset: z.coerce.number().int().min(0).optional(),
})

const itemsQuery = z.object({
  state: z.enum(['pending', 'running', 'succeeded', 'failed', 'held', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

const retryBody = z.object({
  itemIds: z.array(z.string().min(1).max(64)).max(MAX_ITEMS).optional(),
})

interface ResolvedSelection {
  selectionKind: 'ids' | 'query'
  selectionJson: string
  hash: string
  rows: SelectionAssetRow[]
  total: number
  missing: number
}

interface PreviewGeneration {
  v: 1
  kind: string
  count: number
  hash: string
  at: number
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function encodeGeneration(payload: PreviewGeneration): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeGeneration(raw: string): PreviewGeneration | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as PreviewGeneration
    if (parsed.v !== 1 || typeof parsed.kind !== 'string') return null
    if (typeof parsed.count !== 'number' || typeof parsed.hash !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

/** A stable query object, so the same filter hashes the same way twice. */
function canonicalQuery(query: z.infer<typeof assetFilterQuery>): Record<string, unknown> {
  const canonical: Record<string, unknown> = {}
  if (query.libraryId) canonical.libraryId = query.libraryId
  if (query.folderId) canonical.folderId = query.folderId
  if (query.kind) canonical.kind = query.kind
  if (query.tagId) canonical.tagId = query.tagId
  if (query.sort) canonical.sort = query.sort
  if (query.seed !== undefined) canonical.seed = query.seed
  if (query.q) canonical.q = query.q
  if (query.albumId) canonical.albumId = query.albumId
  return canonical
}

/**
 * Resolves the selection once. A query selection re-reads the count and the
 * rows with the same filter compiler the gallery uses, and the hash of the
 * canonical query is what the preview token witnesses.
 */
function resolveSelection(
  ctx: AppContext,
  userId: string,
  selection: z.infer<typeof selectionBody>,
  reply: FastifyReply,
): ResolvedSelection | null {
  if (selection.kind === 'ids') {
    const seen = new Set<string>()
    const ids = selection.assetIds.filter((id) => {
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
    const rows = selectionAssetsByIds(ctx.db, ids)
    const payload = { kind: 'ids', assetIds: ids }
    return {
      selectionKind: 'ids',
      selectionJson: JSON.stringify(payload),
      hash: hashJson(payload),
      rows,
      total: rows.length,
      missing: ids.length - rows.length,
    }
  }

  const filter = toAssetFilter(selection.query)
  if (!applyAlbum(ctx, selection.query.albumId, filter, userId, reply)) return null
  const total = countMatchingAssets(ctx.db, filter)
  const rows = listMatchingAssetRows(ctx.db, filter, MAX_ITEMS)
  const payload = { kind: 'query', query: canonicalQuery(selection.query) }
  return {
    selectionKind: 'query',
    selectionJson: JSON.stringify(payload),
    hash: hashJson(payload),
    rows,
    total,
    missing: 0,
  }
}

function offlineLibraries(db: Db, libraryIds: string[]): Set<string> {
  const offline = new Set<string>()
  for (const libraryId of new Set(libraryIds)) {
    const health = getLibraryHealth(db, libraryId)
    if (!health || health.state !== 'ONLINE') offline.add(libraryId)
  }
  return offline
}

function resolveTag(
  ctx: AppContext,
  params: z.infer<typeof paramsBody>,
  create: boolean,
  reply: FastifyReply,
): string | null {
  if (params.tagId) {
    const tag = getTag(ctx.db, params.tagId)
    if (!tag) {
      reply.code(404).send({ error: 'tag_not_found', message: 'Tag not found.' })
      return null
    }
    return tag.id
  }
  if (!params.tagName) {
    reply.code(400).send({
      error: 'invalid_request',
      message: 'params.tagId 또는 params.tagName이 필요합니다.',
    })
    return null
  }
  const existing = findTagByName(ctx.db, params.tagName)
  if (existing) return existing.id
  if (!create) {
    reply.code(404).send({ error: 'tag_not_found', message: 'Tag not found.' })
    return null
  }
  return createTag(ctx.db, newId(), params.tagName, Date.now()).id
}

function sendPreview(
  ctx: AppContext,
  userId: string,
  body: z.infer<typeof previewBody>,
  reply: FastifyReply,
): void {
  const resolved = resolveSelection(ctx, userId, body.selection, reply)
  if (!resolved) return

  const problems: Array<{ code: string; count: number; message: string }> = []
  if (resolved.total === 0) {
    problems.push({ code: 'no_assets', count: 0, message: '선택한 조건에 맞는 파일이 없습니다.' })
  }
  if (resolved.total > MAX_ITEMS) {
    problems.push({
      code: 'selection_too_large',
      count: resolved.total,
      message: `한 번에 ${MAX_ITEMS.toLocaleString()}개까지 처리할 수 있습니다. 조건을 좁혀 주세요.`,
    })
  }
  if (resolved.missing > 0) {
    problems.push({
      code: 'missing_assets',
      count: resolved.missing,
      message: '이미 삭제되었거나 사라진 파일은 대상에서 빠집니다.',
    })
  }

  const params = body.params ?? {}
  const fileKind = body.kind === 'delete' || body.kind === 'move' || body.kind === 'copy'
  if (fileKind && !ctx.config.fileMutationEnabled) {
    problems.push({
      code: 'mutation_engine_disabled',
      count: resolved.rows.length,
      message: '파일 작업 엔진이 꺼져 있어 삭제·이동·복사를 실행할 수 없습니다.',
    })
  }

  if (fileKind) {
    const offline = offlineLibraries(
      ctx.db,
      resolved.rows.map((row) => row.libraryId),
    )
    if (offline.size > 0) {
      const count = resolved.rows.filter((row) => offline.has(row.libraryId)).length
      problems.push({
        code: 'source_offline',
        count,
        message: '오프라인 라이브러리의 파일은 처리할 수 없습니다.',
      })
    }
  }

  if (body.kind === 'move' || body.kind === 'copy') {
    const targetLibraryId = params.targetLibraryId
    const targetFolder = normalizeTargetFolder(params.targetFolder)
    if (!targetLibraryId) {
      problems.push({
        code: 'target_required',
        count: resolved.rows.length,
        message: '이동·복사할 라이브러리를 골라 주세요.',
      })
    } else if (!getLibrary(ctx.db, targetLibraryId)) {
      problems.push({
        code: 'target_missing',
        count: resolved.rows.length,
        message: '대상 라이브러리를 찾을 수 없습니다.',
      })
    } else if (targetFolder === null) {
      problems.push({
        code: 'target_folder_invalid',
        count: resolved.rows.length,
        message: '대상 폴더 경로가 올바르지 않습니다.',
      })
    } else {
      const targetHealth = getLibraryHealth(ctx.db, targetLibraryId)
      if (!targetHealth || targetHealth.state !== 'ONLINE') {
        problems.push({
          code: 'target_offline',
          count: resolved.rows.length,
          message: '대상 라이브러리가 온라인이 아닙니다.',
        })
      }
      const samePath = resolved.rows.filter(
        (row) =>
          row.libraryId === targetLibraryId &&
          row.relativePath === joinTargetPath(targetFolder, row.filename),
      ).length
      if (samePath > 0) {
        problems.push({
          code: 'target_same_as_source',
          count: samePath,
          message: '이미 같은 위치에 있는 파일은 건너뜁니다.',
        })
      }
      const paths = resolved.rows
        .filter(
          (row) =>
            !(row.libraryId === targetLibraryId &&
              row.relativePath === joinTargetPath(targetFolder, row.filename)),
        )
        .map((row) => joinTargetPath(targetFolder, row.filename))
      const collisions = countTargetCollisions(ctx.db, targetLibraryId, paths, COLLISION_CHUNK)
      if (collisions > 0) {
        problems.push({
          code: 'target_exists',
          count: collisions,
          message: '대상 위치에 같은 이름의 파일이 이미 있습니다.',
        })
      }
    }
  }

  if (body.kind === 'tag_add' || body.kind === 'tag_remove') {
    // A dry run must not create the tag it is describing. A missing name is
    // fine for tag_add (create makes it); a missing id or a missing remove
    // target is a problem the user has to see now.
    if (params.tagId && !getTag(ctx.db, params.tagId)) {
      problems.push({ code: 'tag_missing', count: resolved.rows.length, message: '태그를 찾을 수 없습니다.' })
    } else if (body.kind === 'tag_remove') {
      if (!params.tagId && params.tagName && !findTagByName(ctx.db, params.tagName)) {
        problems.push({
          code: 'tag_missing',
          count: resolved.rows.length,
          message: '제거할 태그를 찾을 수 없습니다.',
        })
      } else if (!params.tagId && !params.tagName) {
        problems.push({
          code: 'tag_required',
          count: resolved.rows.length,
          message: '제거할 태그를 골라 주세요.',
        })
      }
    } else if (!params.tagId && !params.tagName) {
      problems.push({
        code: 'tag_required',
        count: resolved.rows.length,
        message: '붙일 태그를 골라 주세요.',
      })
    }
  }

  const generation = encodeGeneration({
    v: 1,
    kind: body.kind,
    count: resolved.total,
    hash: resolved.hash,
    at: Date.now(),
  })

  reply.send({
    kind: body.kind,
    selectionKind: resolved.selectionKind,
    count: resolved.total,
    totalBytes: resolved.rows.reduce((sum, row) => sum + row.sizeBytes, 0),
    sample: resolved.rows.slice(0, SAMPLE_SIZE).map((row) => ({
      assetId: row.assetId,
      filename: row.filename,
      relativePath: row.relativePath,
      libraryId: row.libraryId,
    })),
    problems,
    availability: {
      delete: ctx.config.fileMutationEnabled,
      move: ctx.config.fileMutationEnabled,
      copy: ctx.config.fileMutationEnabled,
    },
    generation,
  })
}

function selectionItems(rows: SelectionAssetRow[]): BulkSelectionItem[] {
  return rows.map((row) => ({
    assetId: row.assetId,
    filename: row.filename,
    relativePath: row.relativePath,
    sizeBytes: row.sizeBytes,
  }))
}

export function registerBulkOperationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const available = (reply: FastifyReply): boolean => {
    if (ctx.config.bulkOperationsEnabled === true) return true
    reply.code(404).send({ error: 'not_available', message: 'Bulk operations are turned off.' })
    return false
  }

  app.post('/api/bulk-operations/preview', async (request, reply) => {
    if (!available(reply)) return
    const body = parseInput(previewBody, request.body ?? {}, reply)
    if (!body) return
    sendPreview(ctx, request.user!.id, body, reply)
  })

  app.post('/api/bulk-operations', async (request, reply) => {
    if (!available(reply)) return
    const body = parseInput(createBody, request.body ?? {}, reply)
    if (!body) return

    const resolved = resolveSelection(ctx, request.user!.id, body.selection, reply)
    if (!resolved) return
    if (resolved.total > MAX_ITEMS) {
      reply.code(409).send({
        error: 'selection_too_large',
        message: `한 번에 ${MAX_ITEMS.toLocaleString()}개까지 처리할 수 있습니다.`,
        details: { count: resolved.total },
      })
      return
    }
    if (resolved.total === 0) {
      reply.code(409).send({ error: 'no_assets', message: '선택한 조건에 맞는 파일이 없습니다.' })
      return
    }

    const generation = decodeGeneration(body.generation)
    if (
      !generation ||
      generation.kind !== body.kind ||
      generation.hash !== resolved.hash ||
      generation.count !== resolved.total ||
      body.expectedCount !== resolved.total
    ) {
      reply.code(409).send({
        error: 'selection_changed',
        message: '선택한 결과가 미리보기와 달라졌습니다. 다시 확인해 주세요.',
        details: { count: resolved.total, expectedCount: body.expectedCount },
      })
      return
    }

    const params = body.params ?? {}
    let paramsJson: string

    if (body.kind === 'delete') {
      if (!ctx.config.fileMutationEnabled) {
        reply
          .code(503)
          .send({ error: 'mutation_engine_disabled', message: 'The delete engine is turned off.' })
        return
      }
      if (params.confirm !== 'delete') {
        reply.code(400).send({
          error: 'delete_confirmation_required',
          message: '영구 삭제임을 확인하는 params.confirm="delete"가 필요합니다.',
        })
        return
      }
      paramsJson = JSON.stringify({ confirm: 'delete' })
    } else if (body.kind === 'move' || body.kind === 'copy') {
      if (!ctx.config.fileMutationEnabled) {
        reply
          .code(503)
          .send({ error: 'mutation_engine_disabled', message: 'The file engine is turned off.' })
        return
      }
      if (!params.targetLibraryId || !getLibrary(ctx.db, params.targetLibraryId)) {
        reply.code(400).send({ error: 'target_required', message: 'Choose a target library.' })
        return
      }
      const targetFolder = normalizeTargetFolder(params.targetFolder)
      if (targetFolder === null) {
        reply.code(400).send({ error: 'target_folder_invalid', message: 'Invalid target folder.' })
        return
      }
      const targetHealth = getLibraryHealth(ctx.db, params.targetLibraryId)
      if (!targetHealth || targetHealth.state !== 'ONLINE') {
        reply.code(409).send({
          error: 'target_offline',
          message: 'The target library is not online.',
        })
        return
      }
      paramsJson = JSON.stringify({
        targetLibraryId: params.targetLibraryId,
        targetFolder,
      })
    } else if (body.kind === 'tag_add' || body.kind === 'tag_remove') {
      const tagId = resolveTag(ctx, params, body.kind === 'tag_add', reply)
      if (tagId === null) return
      paramsJson = JSON.stringify({ tagId })
    } else if (body.kind === 'reanalyze') {
      const stages = params.stages ?? ['transcript', 'scenes', 'embedding']
      paramsJson = JSON.stringify({
        stages,
        models: {
          asr: {
            modelRevision: ctx.config.asr.modelRevision,
            alignerRevision: ctx.config.asr.alignerRevision,
            pipelineVersion: ctx.config.asr.pipelineVersion,
            retryDelayMs: ctx.config.asr.retryMs,
          },
          scene: {
            modelId: ctx.config.scene.modelId,
            modelRevision: ctx.config.scene.modelRevision,
            modelSha256: ctx.config.scene.modelSha256,
            pipelineVersion: ctx.config.scene.pipelineVersion,
            dimensions: ctx.config.scene.dimensions,
            windowMs: ctx.config.scene.windowMs,
            overlapMs: ctx.config.scene.overlapMs,
          },
          embedding: {
            modelId: ctx.config.embedding.modelId,
            modelRevision: ctx.config.embedding.modelRevision,
            modelSha256: ctx.config.embedding.modelSha256,
            pipelineVersion: ctx.config.embedding.pipelineVersion,
            dimensions: ctx.config.embedding.dimensions,
          },
          translation: {
            modelId: ctx.config.translation.modelId,
            modelRevision: ctx.config.translation.modelRevision,
            modelSha256: ctx.config.translation.modelSha256,
            promptVersion: ctx.config.translation.promptVersion,
            pipelineVersion: ctx.config.translation.pipelineVersion,
            targetLanguage: ctx.config.translation.targetLanguage,
          },
        },
      })
    } else {
      paramsJson = JSON.stringify({})
    }

    const requestKey = `${request.user!.id}:${body.requestId}`
    const existing = getBulkOperationByRequestKey(ctx.db, requestKey)
    if (existing) {
      reply.code(200).send({
        operationId: existing.id,
        state: existing.state,
        statusUrl: `/api/bulk-operations/${existing.id}`,
        created: false,
      })
      return
    }

    const result = createBulkOperation(ctx.db, {
      id: newId(),
      userId: request.user!.id,
      kind: body.kind,
      selectionKind: resolved.selectionKind,
      selectionJson: resolved.selectionJson,
      snapshotCount: resolved.total,
      snapshotHash: resolved.hash,
      snapshotGeneration: body.generation,
      paramsJson,
      requestKey,
      items: selectionItems(resolved.rows),
      now: Date.now(),
    })
    request.log.info(
      {
        operationId: result.record.id,
        kind: result.record.kind,
        count: result.record.snapshotCount,
        created: result.created,
      },
      'bulk operation requested',
    )
    reply.code(result.created ? 202 : 200).send({
      operationId: result.record.id,
      state: result.record.state,
      statusUrl: `/api/bulk-operations/${result.record.id}`,
      created: result.created,
    })
  })

  app.get('/api/bulk-operations', async (request, reply) => {
    if (!available(reply)) return
    const operations = listBulkOperations(ctx.db, request.user!.id, 20)
    reply.send({
      operations: operations.map(({ record, counts }) => toBulkOperationDTO(record, counts)),
    })
  })

  app.get('/api/bulk-operations/:id', async (request, reply) => {
    if (!available(reply)) return
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const query = parseInput(detailQuery, request.query, reply)
    if (!query) return
    const operation = getBulkOperation(ctx.db, params.id, request.user!.id)
    if (!operation) {
      reply.code(404).send({ error: 'not_found', message: 'Bulk operation not found.' })
      return
    }
    const counts = getBulkOperationCounts(ctx.db, operation.id)
    const groups = getBulkOperationErrorGroups(ctx.db, operation.id)
    const items = listBulkOperationItems(ctx.db, operation.id, {
      state: query.itemState,
      limit: query.itemLimit ?? 100,
      offset: query.itemOffset ?? 0,
    })
    reply.send(toBulkOperationDetailDTO(operation, counts, groups, items))
  })

  app.get('/api/bulk-operations/:id/items', async (request, reply) => {
    if (!available(reply)) return
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const query = parseInput(itemsQuery, request.query, reply)
    if (!query) return
    const operation = getBulkOperation(ctx.db, params.id, request.user!.id)
    if (!operation) {
      reply.code(404).send({ error: 'not_found', message: 'Bulk operation not found.' })
      return
    }
    reply.send({
      items: listBulkOperationItems(ctx.db, operation.id, {
        state: query.state,
        limit: query.limit,
        offset: query.offset,
      }).map(toBulkOperationItemDTO),
    })
  })

  app.post('/api/bulk-operations/:id/cancel', async (request, reply) => {
    if (!available(reply)) return
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const result = requestBulkCancel(ctx.db, params.id, request.user!.id, Date.now())
    if (result === 'missing') {
      reply.code(404).send({ error: 'not_found', message: 'Bulk operation not found.' })
      return
    }
    if (result === 'not_active') {
      reply.code(409).send({
        error: 'operation_not_active',
        message: 'This operation has already finished.',
      })
      return
    }
    reply.code(202).send({ state: result })
  })

  app.post('/api/bulk-operations/:id/retry', async (request, reply) => {
    if (!available(reply)) return
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const body = parseInput(retryBody, request.body ?? {}, reply)
    if (!body) return
    const reset = retryBulkItems(
      ctx.db,
      params.id,
      request.user!.id,
      body.itemIds ?? null,
      Date.now(),
    )
    if (reset === null) {
      reply.code(409).send({
        error: 'operation_not_retryable',
        message: 'Only a finished operation with no worker can be retried.',
      })
      return
    }
    reply.code(202).send({ reset })
  })

  app.get('/api/bulk-operations/:id/export', async (request, reply) => {
    if (!available(reply)) return
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const operation = getBulkOperation(ctx.db, params.id, request.user!.id)
    if (!operation) {
      reply.code(404).send({ error: 'not_found', message: 'Bulk operation not found.' })
      return
    }
    if (operation.kind !== 'export') {
      reply.code(404).send({ error: 'not_found', message: 'This operation has no export.' })
      return
    }
    if (operation.state !== 'completed' && operation.state !== 'completed_with_errors') {
      reply.code(409).send({ error: 'export_not_ready', message: 'The export is not ready yet.' })
      return
    }
    const file = path.join(ctx.config.dataDir, 'exports', `${operation.id}.csv`)
    let body: Buffer
    try {
      body = await readFile(file)
    } catch {
      reply.code(404).send({ error: 'export_not_found', message: 'The export file is missing.' })
      return
    }
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="mediavault-${operation.id}.csv"`)
      .send(body)
  })
}
