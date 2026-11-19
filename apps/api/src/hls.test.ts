import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  claimHlsGeneration,
  claimNextJob,
  createHlsRequest,
  createLibrary,
  createUser,
  failHlsGeneration,
  insertAsset,
  markLibraryFailure,
  markLibraryHealthy,
  openDatabase,
  publishHlsGeneration,
  upsertFolder,
  type Db,
} from '@mediavault/database'
import { hlsProfileHash } from '@mediavault/media'
import { PRIORITY } from '@mediavault/shared'
import { buildApp } from './app'
import { SESSION_COOKIE, createSession } from './auth'
import type { ApiConfig } from './config'
import type { AppContext } from './context'
import { Semaphore } from './semaphore'

const SECRET = 'hls-routes-test-secret'
const PROFILE = hlsProfileHash({ width: 1280 })
const ASSET_ID = 'asset0001'
const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function createHarness(options: { enabled: boolean; online?: boolean } = { enabled: true }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-api-hls-'))
  dirs.push(dir)
  const mediaRoot = path.join(dir, 'media')
  const cacheDir = path.join(dir, 'cache')
  const dataDir = path.join(dir, 'data')
  await mkdir(path.join(mediaRoot, 'Lib'), { recursive: true })
  await mkdir(cacheDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  const source = path.join(mediaRoot, 'Lib', 'clip.mp4')
  await writeFile(source, Buffer.alloc(64, 1))

  const db: Db = openDatabase(path.join(dataDir, 'mediavault.db'))
  createUser(db, { id: 'u1', username: 'owner', passwordHash: 'hash', createdAt: 1 })
  createLibrary(db, { id: 'lib1', name: 'Lib', rootPath: 'Lib', createdAt: 1 })
  if (options.online === false) {
    markLibraryFailure(db, { libraryId: 'lib1', state: 'OFFLINE', errorCode: 'root_missing', now: 2 })
  } else {
    markLibraryHealthy(db, { libraryId: 'lib1', rootIdentity: '1:2', now: 1 })
  }
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
  insertAsset(db, {
    id: ASSET_ID,
    libraryId: 'lib1',
    folderId,
    relativePath: 'clip.mp4',
    filename: 'clip.mp4',
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 64,
    mtimeMs: 1,
    width: 1280,
    height: 720,
    durationMs: 10_000,
    takenAt: 1,
    videoCodec: 'h264',
    audioCodec: 'aac',
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
    fileMutationEnabled: false,
    hlsGenerationsEnabled: options.enabled,
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

  const ctx: AppContext = {
    config,
    db,
    thumbnails: new Semaphore(2),
    previews: new Semaphore(2),
  }
  const app = await buildApp(ctx)
  const token = createSession(db, 'u1', SECRET, { ttlMs: 3_600_000 }).token
  const headers = { cookie: `${SESSION_COOKIE}=${token}` }
  return { app, db, cacheDir, headers }
}

async function publishReadyGeneration(h: Awaited<ReturnType<typeof createHarness>>) {
  const created = createHlsRequest(h.db, {
    assetId: ASSET_ID,
    fileVersion: 1,
    profileHash: PROFILE,
    priority: PRIORITY.now,
    now: 1_000,
  })
  // The API computes the profile from the asset width; align the row with it by
  // publishing through the same helper the route uses.
  const job = claimNextJob(h.db, 2_000, { workerId: 'w1', leaseMs: 60_000 })!
  const fence = { workerId: 'w1', leaseEpoch: job.leaseEpoch, jobId: job.id, now: 2_100 }
  claimHlsGeneration(h.db, created.generation.id, fence)

  const storageRel = `hls/${ASSET_ID}/v1/g/${created.generation.id}-attempt`
  const dir = path.join(h.cacheDir, storageRel)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'master.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4.000,\nseg00000.ts\n#EXT-X-ENDLIST\n',
  )
  await writeFile(path.join(dir, 'seg00000.ts'), Buffer.alloc(376, 0x47))
  publishHlsGeneration(h.db, {
    id: created.generation.id,
    fence,
    storageRel,
    playlistRel: `${storageRel}/master.m3u8`,
    encoder: 'libx264',
    graceMs: 1_000,
  })
  return { created, job, fence, storageRel }
}

describe('HLS generation routes', () => {
  test('a missing generation becomes a queued request', async () => {
    const h = await createHarness()
    const response = await h.app.inject({ method: 'GET', url: `/api/assets/${ASSET_ID}/hls`, headers: h.headers })
    expect(response.statusCode).toBe(202)
    expect(response.headers['retry-after']).toBe('2')
    expect(response.headers['cache-control']).toBe('no-store')
    const body = response.json() as { state: string; generationId: string }
    expect(body.state).toBe('queued')
    expect(body.generationId).toBeTruthy()
    const rows = h.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM hls_generations').get()!.n
    expect(rows).toBe(1)
    h.db.close()
  })

  test('a ready generation serves its playlist and segments', async () => {
    const h = await createHarness()
    const { created } = await publishReadyGeneration(h)

    const status = await h.app.inject({ method: 'GET', url: `/api/assets/${ASSET_ID}/hls`, headers: h.headers })
    expect(status.statusCode).toBe(200)
    const body = status.json() as { state: string; playlistUrl: string }
    expect(body.state).toBe('ready')
    expect(body.playlistUrl).toBe(`/api/assets/${ASSET_ID}/hls/g/${created.generation.id}/master.m3u8`)

    const playlist = await h.app.inject({ method: 'GET', url: body.playlistUrl, headers: h.headers })
    expect(playlist.statusCode).toBe(200)
    expect(playlist.headers['content-type']).toContain('application/vnd.apple.mpegurl')
    expect(playlist.body).toContain('seg00000.ts')

    const segment = await h.app.inject({
      method: 'GET',
      url: `/api/assets/${ASSET_ID}/hls/g/${created.generation.id}/seg00000.ts`,
      headers: h.headers,
    })
    expect(segment.statusCode).toBe(200)
    expect(segment.headers['content-type']).toContain('video/mp2t')

    const missing = await h.app.inject({
      method: 'GET',
      url: `/api/assets/${ASSET_ID}/hls/g/${created.generation.id}/seg00001.ts`,
      headers: h.headers,
    })
    expect(missing.statusCode).toBe(404)
    const wrongGeneration = await h.app.inject({
      method: 'GET',
      url: `/api/assets/${ASSET_ID}/hls/g/zzzzzzzzzzzz/master.m3u8`,
      headers: h.headers,
    })
    expect(wrongGeneration.statusCode).toBe(404)
    h.db.close()
  })

  test('a ready cache plays while the library is offline', async () => {
    const h = await createHarness({ enabled: true, online: false })
    const { created } = await publishReadyGeneration(h)
    const status = await h.app.inject({ method: 'GET', url: `/api/assets/${ASSET_ID}/hls`, headers: h.headers })
    expect(status.statusCode).toBe(200)
    expect((status.json() as { state: string }).state).toBe('ready')
    h.db.close()
  })

  test('no cache with an offline library is a 503', async () => {
    const h = await createHarness({ enabled: true, online: false })
    const status = await h.app.inject({ method: 'GET', url: `/api/assets/${ASSET_ID}/hls`, headers: h.headers })
    expect(status.statusCode).toBe(503)
    expect((status.json() as { state: string }).state).toBe('source_offline')
    h.db.close()
  })

  test('a failed generation reports its error and retry creates a new one', async () => {
    const h = await createHarness()
    const first = createHlsRequest(h.db, {
      assetId: ASSET_ID,
      fileVersion: 1,
      profileHash: PROFILE,
      priority: PRIORITY.now,
      now: 1_000,
    })
    const job = claimNextJob(h.db, 2_000, { workerId: 'w1', leaseMs: 60_000 })!
    const fence = { workerId: 'w1', leaseEpoch: job.leaseEpoch, jobId: job.id, now: 2_100 }
    claimHlsGeneration(h.db, first.generation.id, fence)
    failHlsGeneration(h.db, first.generation.id, fence, {
      state: 'failed',
      errorCode: 'encode_failed',
      errorMessage: 'boom',
    })

    const status = await h.app.inject({ method: 'GET', url: `/api/assets/${ASSET_ID}/hls`, headers: h.headers })
    expect(status.statusCode).toBe(200)
    const body = status.json() as { state: string; errorCode: string; message: string }
    expect(body.state).toBe('failed')
    expect(body.errorCode).toBe('encode_failed')
    expect(body.message).toBe('boom')

    const retry = await h.app.inject({
      method: 'POST',
      url: `/api/assets/${ASSET_ID}/hls/retry`,
      headers: h.headers,
    })
    expect(retry.statusCode).toBe(202)
    const retried = retry.json() as { generationId: string; state: string }
    expect(retried.generationId).not.toBe(first.generation.id)
    expect(retried.state).toBe('queued')
    h.db.close()
  })

  test('the legacy playlist is pinned to the active generation', async () => {
    const h = await createHarness()
    const { created } = await publishReadyGeneration(h)

    const legacy = await h.app.inject({
      method: 'GET',
      url: `/api/assets/${ASSET_ID}/hls/master.m3u8`,
      headers: h.headers,
    })
    expect(legacy.statusCode).toBe(200)
    expect(legacy.body).toContain(`/api/assets/${ASSET_ID}/hls/g/${created.generation.id}/seg00000.ts`)

    const segment = await h.app.inject({
      method: 'GET',
      url: `/api/assets/${ASSET_ID}/hls/seg00000.ts`,
      headers: h.headers,
    })
    expect(segment.statusCode).toBe(302)
    expect(segment.headers.location).toBe(`/api/assets/${ASSET_ID}/hls/g/${created.generation.id}/seg00000.ts`)
    h.db.close()
  })

  test('with the flag off the legacy path and status still work', async () => {
    const h = await createHarness({ enabled: false })
    const status = await h.app.inject({ method: 'GET', url: `/api/assets/${ASSET_ID}/hls`, headers: h.headers })
    expect(status.statusCode).toBe(202)
    expect((status.json() as { state: string }).state).toBe('queued')

    const legacy = await h.app.inject({
      method: 'GET',
      url: `/api/assets/${ASSET_ID}/hls/master.m3u8`,
      headers: h.headers,
    })
    expect(legacy.statusCode).toBe(202)
    expect((legacy.json() as { state: string }).state).toBe('preparing')

    const generation = await h.app.inject({
      method: 'GET',
      url: `/api/assets/${ASSET_ID}/hls/g/zzzzzzzzzzzz/master.m3u8`,
      headers: h.headers,
    })
    expect(generation.statusCode).toBe(404)
    expect(h.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM hls_generations').get()!.n).toBe(0)
    h.db.close()
  })
})
