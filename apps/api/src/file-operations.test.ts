import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createLibrary,
  createUser,
  getFileMutation,
  insertAsset,
  markLibraryFailure,
  markLibraryHealthy,
  openDatabase,
  upsertFolder,
  type Db,
} from '@mediavault/database'
import type { FileOperationDTO } from '@mediavault/shared'
import { buildApp } from './app'
import { SESSION_COOKIE, createSessionToken } from './auth'
import type { ApiConfig } from './config'
import type { AppContext } from './context'
import { Semaphore } from './semaphore'

const SECRET = 'file-operations-test-secret'
const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function createHarness(options: { enabled: boolean; online?: boolean } = { enabled: true }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-api-mutations-'))
  dirs.push(dir)
  const mediaRoot = path.join(dir, 'media')
  const cacheDir = path.join(dir, 'cache')
  const dataDir = path.join(dir, 'data')
  await mkdir(path.join(mediaRoot, 'Lib'), { recursive: true })
  await mkdir(cacheDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  const file = path.join(mediaRoot, 'Lib', 'clip.mp4')
  await writeFile(file, Buffer.alloc(64, 3))
  const info = await stat(file)

  const db: Db = openDatabase(path.join(dataDir, 'mediavault.db'))
  createUser(db, { id: 'u1', username: 'owner', passwordHash: 'hash', createdAt: 1 })
  createLibrary(db, { id: 'lib1', name: 'Lib', rootPath: 'Lib', createdAt: 1 })
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
  if (options.online === false) {
    markLibraryFailure(db, { libraryId: 'lib1', state: 'OFFLINE', errorCode: 'root_missing', now: 2 })
  } else {
    markLibraryHealthy(db, { libraryId: 'lib1', rootIdentity: '1:2', now: 1 })
  }
  insertAsset(db, {
    id: 'a1',
    libraryId: 'lib1',
    folderId,
    relativePath: 'clip.mp4',
    filename: 'clip.mp4',
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: info.size,
    mtimeMs: Math.round(info.mtimeMs),
    width: null,
    height: null,
    durationMs: null,
    takenAt: 1,
    videoCodec: null,
    audioCodec: null,
    container: 'mp4',
    indexedAt: 1,
    scanId: 's1',
  })

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
    fileMutationEnabled: options.enabled,
    gpu: { resourceId: 'gpu:0' },
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
      queryUrl: 'http://127.0.0.1:9999',
    },
  }

  const ctx: AppContext = {
    config,
    db,
    thumbnails: new Semaphore(2),
    previews: new Semaphore(2),
  }
  const app = await buildApp(ctx)
  const token = createSessionToken('u1', SECRET, 3_600_000)
  const headers = { cookie: `${SESSION_COOKIE}=${token}` }
  return { app, db, file, headers }
}

describe('file operation routes', () => {
  test('refuses every delete while the engine is off', async () => {
    const h = await createHarness({ enabled: false })
    const post = await h.app.inject({
      method: 'POST',
      url: '/api/assets/a1/delete-operations',
      headers: { ...h.headers, 'idempotency-key': 'k1' },
    })
    expect(post.statusCode).toBe(503)
    expect((post.json() as { error: string }).error).toBe('mutation_engine_disabled')

    const legacy = await h.app.inject({ method: 'DELETE', url: '/api/assets/a1', headers: h.headers })
    expect(legacy.statusCode).toBe(503)
    expect(h.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM file_mutations').get()?.n).toBe(0)
    h.db.close()
  })

  test('requires an idempotency key and returns the same operation for a retry', async () => {
    const h = await createHarness()
    const missing = await h.app.inject({
      method: 'POST',
      url: '/api/assets/a1/delete-operations',
      headers: h.headers,
    })
    expect(missing.statusCode).toBe(400)

    const first = await h.app.inject({
      method: 'POST',
      url: '/api/assets/a1/delete-operations',
      headers: { ...h.headers, 'idempotency-key': 'client-key' },
    })
    expect(first.statusCode).toBe(202)
    const operation = first.json() as FileOperationDTO
    expect(operation.state).toBe('requested')
    expect(operation.statusUrl).toBe(`/api/file-operations/${operation.id}`)

    const again = await h.app.inject({
      method: 'POST',
      url: '/api/assets/a1/delete-operations',
      headers: { ...h.headers, 'idempotency-key': 'client-key' },
    })
    expect(again.statusCode).toBe(202)
    expect((again.json() as FileOperationDTO).id).toBe(operation.id)

    const fetched = await h.app.inject({
      method: 'GET',
      url: operation.statusUrl,
      headers: h.headers,
    })
    expect(fetched.statusCode).toBe(200)
    expect((fetched.json() as FileOperationDTO).assetId).toBe('a1')
    h.db.close()
  })

  test('refuses a delete while the library is offline', async () => {
    const h = await createHarness({ enabled: true, online: false })
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/assets/a1/delete-operations',
      headers: { ...h.headers, 'idempotency-key': 'k-offline' },
    })
    expect(response.statusCode).toBe(409)
    expect((response.json() as { error: string }).error).toBe('source_offline')
    h.db.close()
  })

  test('the legacy DELETE queues an operation and leaves the file in place', async () => {
    const h = await createHarness()
    const response = await h.app.inject({ method: 'DELETE', url: '/api/assets/a1', headers: h.headers })
    expect(response.statusCode).toBe(202)
    const operation = response.json() as FileOperationDTO
    expect(getFileMutation(h.db, operation.id)?.state).toBe('requested')
    expect(await stat(h.file).then(() => true)).toBe(true)
    h.db.close()
  })

  test('retry is refused while the operation is still requested', async () => {
    const h = await createHarness()
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/assets/a1/delete-operations',
      headers: { ...h.headers, 'idempotency-key': 'k-retry' },
    })
    const operation = created.json() as FileOperationDTO
    const retried = await h.app.inject({
      method: 'POST',
      url: `/api/file-operations/${operation.id}/retry`,
      headers: h.headers,
    })
    expect(retried.statusCode).toBe(409)
    h.db.close()
  })

  test('an unknown operation is a 404', async () => {
    const h = await createHarness()
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/file-operations/does-not-exist',
      headers: h.headers,
    })
    expect(response.statusCode).toBe(404)
    h.db.close()
  })
})
