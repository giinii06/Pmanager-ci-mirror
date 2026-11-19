import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createLibrary,
  createUser,
  insertAsset,
  markLibraryHealthy,
  openDatabase,
  upsertFolder,
  type Db,
} from '@mediavault/database'
import type {
  BulkOperationDTO,
  BulkOperationDetailDTO,
  BulkOperationListDTO,
  BulkPreviewDTO,
} from '@mediavault/shared'
import { buildApp } from './app'
import { SESSION_COOKIE, createSession } from './auth'
import type { ApiConfig } from './config'
import type { AppContext } from './context'
import { Semaphore } from './semaphore'

const SECRET = 'bulk-operations-test-secret'
const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function createHarness(
  options: { bulk?: boolean; engine?: boolean } = {},
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-api-bulk-'))
  dirs.push(dir)
  const mediaRoot = path.join(dir, 'media')
  const cacheDir = path.join(dir, 'cache')
  const dataDir = path.join(dir, 'data')
  await mkdir(path.join(mediaRoot, 'Lib'), { recursive: true })
  await mkdir(path.join(mediaRoot, 'Lib2'), { recursive: true })
  await mkdir(cacheDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })

  const db: Db = openDatabase(path.join(dataDir, 'mediavault.db'))
  createUser(db, { id: 'u1', username: 'owner', passwordHash: 'hash', createdAt: 1 })
  createUser(db, { id: 'u2', username: 'guest', passwordHash: 'hash', createdAt: 1 })
  createLibrary(db, { id: 'lib1', name: 'Lib', rootPath: 'Lib', createdAt: 1 })
  createLibrary(db, { id: 'lib2', name: 'Lib2', rootPath: 'Lib2', createdAt: 1 })
  markLibraryHealthy(db, { libraryId: 'lib1', rootIdentity: '1:2', now: 1 })
  markLibraryHealthy(db, { libraryId: 'lib2', rootIdentity: '3:4', now: 1 })
  const folderId = upsertFolder(db, {
    id: 'f1',
    libraryId: 'lib1',
    parentId: null,
    relativePath: '',
    name: 'Lib',
    depth: 0,
    scanId: 's1',
    createdAt: 1,
  })
  const folder2 = upsertFolder(db, {
    id: 'f2',
    libraryId: 'lib2',
    parentId: null,
    relativePath: '',
    name: 'Lib2',
    depth: 0,
    scanId: 's1',
    createdAt: 1,
  })
  const assets = [
    { id: 'vid001', name: 'vid001.mp4', kind: 'video', size: 1000, takenAt: 1000, library: 'lib1', folder: folderId },
    { id: 'vid002', name: 'vid002.mp4', kind: 'video', size: 2000, takenAt: 2000, library: 'lib1', folder: folderId },
    { id: 'vid003', name: 'vid003.mp4', kind: 'video', size: 3000, takenAt: 3000, library: 'lib1', folder: folderId },
    { id: 'img001', name: 'img001.jpg', kind: 'image', size: 500, takenAt: 4000, library: 'lib1', folder: folderId },
    { id: 'col001', name: 'vid001.mp4', kind: 'video', size: 1000, takenAt: 5000, library: 'lib2', folder: folder2 },
  ] as const
  for (const asset of assets) {
    insertAsset(db, {
      id: asset.id,
      libraryId: asset.library,
      folderId: asset.folder,
      relativePath: asset.name,
      filename: asset.name,
      kind: asset.kind,
      mimeType: asset.kind === 'video' ? 'video/mp4' : 'image/jpeg',
      sizeBytes: asset.size,
      mtimeMs: 1_000,
      width: 100,
      height: 100,
      durationMs: asset.kind === 'video' ? 1_000 : null,
      takenAt: asset.takenAt,
      videoCodec: null,
      audioCodec: null,
      container: 'mp4',
      indexedAt: asset.takenAt,
      scanId: 's1',
    })
  }

  const config: ApiConfig = {
    port: 0,
    host: '127.0.0.1',
    dataDir,
    cacheDir,
    mediaRoot,
    authSecret: SECRET,
    accel: false,
    hwaccel: null,
    secureCookies: false,
    scanIntervalMs: 60_000,
    fileMutationEnabled: options.engine ?? false,
    hlsGenerationsEnabled: false,
    smartAlbumsEnabled: true,
    bulkOperationsEnabled: options.bulk ?? true,
    trustProxy: [],
    publicOrigins: [],
    gpu: { resourceId: 'gpu:0' },
    search: { ftsEnabled: false },
    asr: {
      enabled: false,
      workerToken: 't',
      resultDir: path.join(dir, 'asr'),
      modelRevision: 'm',
      alignerRevision: 'a',
      pipelineVersion: 'p',
      retryMs: 60_000,
    },
    translation: {
      enabled: false,
      workerToken: 't',
      resultDir: path.join(dir, 'tr'),
      modelId: 'm',
      modelRevision: 'r',
      modelSha256: 's',
      promptVersion: 'p',
      pipelineVersion: 'v',
      targetLanguage: 'ko',
    },
    embedding: {
      enabled: false,
      workerToken: 't',
      modelId: 'm',
      modelRevision: 'r',
      modelSha256: 's',
      pipelineVersion: 'v',
      dimensions: 3,
    },
    scene: {
      enabled: false,
      workerToken: 't',
      modelId: 'm',
      modelRevision: 'r',
      modelSha256: 's',
      pipelineVersion: 'v',
      dimensions: 3,
      windowMs: 4000,
      overlapMs: 0,
      maxWindows: 120,
      queryUrl: 'http://127.0.0.1:9999',
    },
  }

  const ctx: AppContext = { config, db, thumbnails: new Semaphore(2), previews: new Semaphore(2) }
  const app = await buildApp(ctx)
  const headers = { cookie: `${SESSION_COOKIE}=${createSession(db, 'u1', SECRET, { ttlMs: 3_600_000 }).token}` }
  const guest = { cookie: `${SESSION_COOKIE}=${createSession(db, 'u2', SECRET, { ttlMs: 3_600_000 }).token}` }
  return { app, db, headers, guest, dataDir }
}

type Harness = Awaited<ReturnType<typeof createHarness>>

async function preview(harness: Harness, payload: Record<string, unknown>): Promise<BulkPreviewDTO> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/bulk-operations/preview',
    headers: harness.headers,
    payload,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as BulkPreviewDTO
}

async function createOperation(
  harness: Harness,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: { operationId: string; state: string; created: boolean } }> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/bulk-operations',
    headers: harness.headers,
    payload,
  })
  return {
    statusCode: response.statusCode,
    body: response.json() as { operationId: string; state: string; created: boolean },
  }
}

function idsSelection(assetIds: string[]) {
  return { kind: 'ids', assetIds }
}

describe('bulk operation API', () => {
  test('the routes are off unless the flag is on and require a session', async () => {
    const off = await createHarness({ bulk: false })
    const previewOff = await off.app.inject({
      method: 'POST',
      url: '/api/bulk-operations/preview',
      headers: off.headers,
      payload: { kind: 'tag_add', selection: idsSelection(['vid001']), params: { tagName: 'x' } },
    })
    expect(previewOff.statusCode).toBe(404)

    const on = await createHarness()
    const anonymous = await on.app.inject({
      method: 'GET',
      url: '/api/bulk-operations',
    })
    expect(anonymous.statusCode).toBe(401)
  })

  test('a preview reports the count, bytes, sample and a generation token', async () => {
    const harness = await createHarness()
    const body = await preview(harness, {
      kind: 'tag_add',
      selection: idsSelection(['vid001', 'vid002', 'vid001']),
      params: { tagName: 'Keep' },
    })
    expect(body.selectionKind).toBe('ids')
    expect(body.count).toBe(2)
    expect(body.totalBytes).toBe(3000)
    expect(body.sample.map((entry) => entry.assetId)).toEqual(['vid001', 'vid002'])
    expect(body.generation.length).toBeGreaterThan(10)
    expect(body.availability.delete).toBe(false)
    // A dry run must not create the tag.
    const tags = harness.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM tags').get()!
    expect(tags.n).toBe(0)
  })

  test('a filter selection counts the whole result and create freezes it', async () => {
    const harness = await createHarness()
    const body = await preview(harness, {
      kind: 'export',
      selection: { kind: 'query', query: { kind: 'video' } },
    })
    expect(body.count).toBe(4)
    expect(body.selectionKind).toBe('query')

    const created = await createOperation(harness, {
      kind: 'export',
      selection: { kind: 'query', query: { kind: 'video' } },
      generation: body.generation,
      expectedCount: 4,
      requestId: 'req-export-1',
    })
    expect(created.statusCode).toBe(202)
    expect(created.body.created).toBe(true)

    const detail = await harness.app.inject({
      method: 'GET',
      url: `/api/bulk-operations/${created.body.operationId}`,
      headers: harness.headers,
    })
    const operation = detail.json() as BulkOperationDetailDTO
    expect(operation.snapshotCount).toBe(4)
    expect(operation.items).toHaveLength(4)
    expect(operation.counts.pending).toBe(4)
  })

  test('a repeated request id returns the original operation', async () => {
    const harness = await createHarness()
    const body = await preview(harness, {
      kind: 'poster',
      selection: idsSelection(['vid001', 'vid002']),
    })
    const first = await createOperation(harness, {
      kind: 'poster',
      selection: idsSelection(['vid001', 'vid002']),
      generation: body.generation,
      expectedCount: 2,
      requestId: 'req-same-1',
    })
    const second = await createOperation(harness, {
      kind: 'poster',
      selection: idsSelection(['vid001', 'vid002']),
      generation: body.generation,
      expectedCount: 2,
      requestId: 'req-same-1',
    })
    expect(first.statusCode).toBe(202)
    expect(second.statusCode).toBe(200)
    expect(second.body.operationId).toBe(first.body.operationId)
    expect(second.body.created).toBe(false)
  })

  test('a result set that changed after the preview is refused', async () => {
    const harness = await createHarness()
    const body = await preview(harness, {
      kind: 'poster',
      selection: idsSelection(['vid001', 'vid002', 'vid003']),
    })
    harness.db.query<null, []>(`UPDATE assets SET deleted_at = 5 WHERE id = 'vid003'`).run()
    const created = await createOperation(harness, {
      kind: 'poster',
      selection: idsSelection(['vid001', 'vid002', 'vid003']),
      generation: body.generation,
      expectedCount: 3,
      requestId: 'req-changed-1',
    })
    expect(created.statusCode).toBe(409)
    expect(harness.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM bulk_operations').get()!.n).toBe(0)
  })

  test('delete needs the engine and an explicit confirmation', async () => {
    const off = await createHarness({ engine: false })
    const previewOff = await preview(off, {
      kind: 'delete',
      selection: idsSelection(['vid001']),
    })
    expect(previewOff.availability.delete).toBe(false)
    const refused = await createOperation(off, {
      kind: 'delete',
      selection: idsSelection(['vid001']),
      generation: previewOff.generation,
      expectedCount: 1,
      requestId: 'req-delete-off',
      params: { confirm: 'delete' },
    })
    expect(refused.statusCode).toBe(503)

    const on = await createHarness({ engine: true })
    const body = await preview(on, { kind: 'delete', selection: idsSelection(['vid001']) })
    const unconfirmed = await createOperation(on, {
      kind: 'delete',
      selection: idsSelection(['vid001']),
      generation: body.generation,
      expectedCount: 1,
      requestId: 'req-delete-no-confirm',
    })
    expect(unconfirmed.statusCode).toBe(400)

    const confirmed = await createOperation(on, {
      kind: 'delete',
      selection: idsSelection(['vid001']),
      generation: body.generation,
      expectedCount: 1,
      requestId: 'req-delete-confirm',
      params: { confirm: 'delete' },
    })
    expect(confirmed.statusCode).toBe(202)
  })

  test('a move preview reports a collision and refuses the same source path', async () => {
    const harness = await createHarness({ engine: true })
    const body = await preview(harness, {
      kind: 'move',
      selection: idsSelection(['vid001']),
      params: { targetLibraryId: 'lib2', targetFolder: '' },
    })
    expect(body.problems.some((problem) => problem.code === 'target_exists')).toBe(true)

    const same = await preview(harness, {
      kind: 'move',
      selection: idsSelection(['vid001']),
      params: { targetLibraryId: 'lib1', targetFolder: '' },
    })
    expect(same.problems.some((problem) => problem.code === 'target_same_as_source')).toBe(true)

    const created = await createOperation(harness, {
      kind: 'move',
      selection: idsSelection(['vid001']),
      params: { targetLibraryId: 'lib2', targetFolder: 'sorted' },
      generation: body.generation,
      expectedCount: 1,
      requestId: 'req-move-1',
    })
    expect(created.statusCode).toBe(202)
  })

  test('the single-asset move endpoint needs a key, an online target and a new path', async () => {
    const harness = await createHarness({ engine: true })
    const move = (payload: Record<string, unknown>, key?: string) =>
      harness.app.inject({
        method: 'POST',
        url: '/api/assets/vid001/move-operations',
        headers: { ...harness.headers, ...(key ? { 'idempotency-key': key } : {}) },
        payload,
      })

    expect((await move({ targetLibraryId: 'lib2' })).statusCode).toBe(400)
    const missing = await move({ targetLibraryId: 'nope' }, 'move-missing')
    expect(missing.statusCode).toBe(404)
    expect((missing.json() as { error: string }).error).toBe('target_missing')
    const same = await move({ targetLibraryId: 'lib1', targetFolder: '' }, 'move-same')
    expect(same.statusCode).toBe(409)
    expect((same.json() as { error: string }).error).toBe('target_same_as_source')

    const created = await move({ targetLibraryId: 'lib2', targetFolder: 'sorted' }, 'move-ok')
    expect(created.statusCode).toBe(202)
    const record = created.json() as { id: string; kind: string; state: string }
    expect(record.kind).toBe('move')
    expect(record.state).toBe('requested')
    const row = harness.db
      .query<{ targetLibraryId: string; targetRel: string; requestKey: string }, [string]>(
        `SELECT target_library_id AS targetLibraryId, target_rel AS targetRel,
                request_key AS requestKey
         FROM file_mutations WHERE id = ?`,
      )
      .get(record.id)!
    expect(row).toEqual({
      targetLibraryId: 'lib2',
      targetRel: 'sorted/vid001.mp4',
      requestKey: 'u1:move-ok',
    })

    const repeated = await move({ targetLibraryId: 'lib2', targetFolder: 'sorted' }, 'move-ok')
    expect((repeated.json() as { id: string }).id).toBe(record.id)
    expect(
      harness.db
        .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM file_mutations WHERE kind = 'move'`)
        .get()?.n,
    ).toBe(1)

    const off = await createHarness({ engine: false })
    const refused = await off.app.inject({
      method: 'POST',
      url: '/api/assets/vid001/move-operations',
      headers: { ...off.headers, 'idempotency-key': 'move-off' },
      payload: { targetLibraryId: 'lib2' },
    })
    expect(refused.statusCode).toBe(503)
  })

  test('a tag add resolves the name at create and stores only the id', async () => {
    const harness = await createHarness()
    const body = await preview(harness, {
      kind: 'tag_add',
      selection: idsSelection(['vid001', 'vid002']),
      params: { tagName: 'Keep' },
    })
    const created = await createOperation(harness, {
      kind: 'tag_add',
      selection: idsSelection(['vid001', 'vid002']),
      params: { tagName: 'Keep' },
      generation: body.generation,
      expectedCount: 2,
      requestId: 'req-tag-1',
    })
    expect(created.statusCode).toBe(202)
    const tag = harness.db
      .query<{ id: string }, []>(`SELECT id FROM tags WHERE name = 'Keep'`)
      .get()!
    const row = harness.db
      .query<{ params: string }, [string]>(
        `SELECT params_json AS params FROM bulk_operations WHERE id = ?`,
      )
      .get(created.body.operationId)!
    expect(JSON.parse(row.params)).toEqual({ tagId: tag.id })
  })

  test('cancel stops a queued operation and the detail reports it', async () => {
    const harness = await createHarness()
    const body = await preview(harness, {
      kind: 'poster',
      selection: idsSelection(['vid001', 'vid002']),
    })
    const created = await createOperation(harness, {
      kind: 'poster',
      selection: idsSelection(['vid001', 'vid002']),
      generation: body.generation,
      expectedCount: 2,
      requestId: 'req-cancel-1',
    })
    const cancelled = await harness.app.inject({
      method: 'POST',
      url: `/api/bulk-operations/${created.body.operationId}/cancel`,
      headers: harness.headers,
    })
    expect(cancelled.statusCode).toBe(202)
    expect((cancelled.json() as { state: string }).state).toBe('cancelled')

    const detail = await harness.app.inject({
      method: 'GET',
      url: `/api/bulk-operations/${created.body.operationId}`,
      headers: harness.headers,
    })
    const operation = detail.json() as BulkOperationDetailDTO
    expect(operation.state).toBe('cancelled')
    expect(operation.counts.cancelled).toBe(2)
  })

  test('retry requeues failed items and only the owner can see the operation', async () => {
    const harness = await createHarness()
    const body = await preview(harness, {
      kind: 'poster',
      selection: idsSelection(['vid001']),
    })
    const created = await createOperation(harness, {
      kind: 'poster',
      selection: idsSelection(['vid001']),
      generation: body.generation,
      expectedCount: 1,
      requestId: 'req-retry-1',
    })
    const id = created.body.operationId
    harness.db
      .query<null, [string]>(
        `UPDATE bulk_operation_items SET state = 'failed', error_code = 'x' WHERE operation_id = ?`,
      )
      .run(id)
    harness.db
      .query<null, [string]>(`UPDATE bulk_operations SET state = 'completed_with_errors' WHERE id = ?`)
      .run(id)

    const guest = await harness.app.inject({
      method: 'GET',
      url: `/api/bulk-operations/${id}`,
      headers: harness.guest,
    })
    expect(guest.statusCode).toBe(404)

    const retried = await harness.app.inject({
      method: 'POST',
      url: `/api/bulk-operations/${id}/retry`,
      headers: harness.headers,
      payload: {},
    })
    expect(retried.statusCode).toBe(202)
    expect((retried.json() as { reset: number }).reset).toBe(1)
  })

  test('an export is downloadable only after it is written', async () => {
    const harness = await createHarness()
    const body = await preview(harness, {
      kind: 'export',
      selection: idsSelection(['vid001', 'vid002']),
    })
    const created = await createOperation(harness, {
      kind: 'export',
      selection: idsSelection(['vid001', 'vid002']),
      generation: body.generation,
      expectedCount: 2,
      requestId: 'req-export-2',
    })
    const id = created.body.operationId

    const early = await harness.app.inject({
      method: 'GET',
      url: `/api/bulk-operations/${id}/export`,
      headers: harness.headers,
    })
    expect(early.statusCode).toBe(409)

    await mkdir(path.join(harness.dataDir, 'exports'), { recursive: true })
    await writeFile(path.join(harness.dataDir, 'exports', `${id}.csv`), 'asset_id\nvid001\n')
    harness.db
      .query<null, [string]>(`UPDATE bulk_operations SET state = 'completed' WHERE id = ?`)
      .run(id)
    const download = await harness.app.inject({
      method: 'GET',
      url: `/api/bulk-operations/${id}/export`,
      headers: harness.headers,
    })
    expect(download.statusCode).toBe(200)
    expect(download.headers['content-type']).toContain('text/csv')
    expect(download.body).toContain('vid001')
  })

  test('the list returns the caller operations only', async () => {
    const harness = await createHarness()
    const body = await preview(harness, { kind: 'poster', selection: idsSelection(['vid001']) })
    await createOperation(harness, {
      kind: 'poster',
      selection: idsSelection(['vid001']),
      generation: body.generation,
      expectedCount: 1,
      requestId: 'req-list-1',
    })
    const list = await harness.app.inject({
      method: 'GET',
      url: '/api/bulk-operations',
      headers: harness.headers,
    })
    expect(list.statusCode).toBe(200)
    expect((list.json() as BulkOperationListDTO).operations).toHaveLength(1)

    const guest = await harness.app.inject({
      method: 'GET',
      url: '/api/bulk-operations',
      headers: harness.guest,
    })
    expect((guest.json() as BulkOperationListDTO).operations).toHaveLength(0)
  })
})
