import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  claimSceneJob,
  completeAsrJob,
  completeSceneJob,
  createAsrJob,
  createLibrary,
  createSceneJob,
  createUser,
  insertAsset,
  openDatabase,
  upsertFolder,
  type Db,
} from '@mediavault/database'
import type { NewAsset } from '@mediavault/database'
import { buildApp } from './app'
import { SESSION_COOKIE, createSession } from './auth'
import type { ApiConfig } from './config'
import type { AppContext } from './context'
import { Semaphore } from './semaphore'

const SECRET = 'test-secret-for-session-signing'
const SCENE_TOKEN = 'scene-token-0000000'
const SCENE_SHA = 'scene-sha'
const SCENE_PIPELINE = 'scene-1'
const DIMENSIONS = 4

const dirs: string[] = []
const servers: Array<{ stop: (force?: boolean) => void }> = []

afterAll(async () => {
  for (const server of servers) server.stop(true)
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mediavault-scene-'))
  dirs.push(dir)
  return dir
}

function assetInput(id: string, folderId: string): NewAsset {
  return {
    id,
    libraryId: 'lib1',
    folderId,
    relativePath: `Videos/${id}.mp4`,
    filename: `${id}.mp4`,
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 1_000,
    mtimeMs: 1_000,
    width: 1_080,
    height: 1_920,
    durationMs: 60_000,
    takenAt: 10_000,
    videoCodec: 'h264',
    audioCodec: 'aac',
    container: 'mov,mp4',
    indexedAt: 20_000,
    scanId: 'scan1',
  }
}

function unit(values: number[]): Float32Array {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
  return Float32Array.from(values.map((value) => value / norm))
}

function encode(values: number[]): string {
  return Buffer.from(unit(values).buffer).toString('base64')
}

interface Harness {
  db: Db
  app: Awaited<ReturnType<typeof buildApp>>
  cookie: string
  cacheDir: string
  queryUrl: string
  stopQuery: () => void
}

async function harness(options: { sceneEnabled?: boolean; query?: boolean } = {}): Promise<Harness> {
  const dataDir = await makeDir()
  const cacheDir = await makeDir()
  const db = openDatabase(':memory:')

  createUser(db, { id: 'user1', username: 'owner', passwordHash: 'x', createdAt: 1 })
  createLibrary(db, { id: 'lib1', name: 'Videos', rootPath: 'Videos', createdAt: 1 })
  const folderId = upsertFolder(db, {
    id: 'folder1',
    libraryId: 'lib1',
    parentId: null,
    relativePath: 'Videos',
    name: 'Videos',
    depth: 0,
    scanId: 'scan1',
  })
  insertAsset(db, assetInput('asset1', folderId))
  insertAsset(db, assetInput('asset2', folderId))

  createAsrJob(
    db,
    {
      id: 'asr1',
      assetId: 'asset2',
      fileVersion: 1,
      modelRevision: 'asr-rev',
      alignerRevision: 'align-rev',
      pipelineVersion: 'asr-1',
    },
    1_000,
  )
  completeAsrJob(
    db,
    {
      jobId: 'asr1',
      transcriptId: 'transcript1',
      resultDir: 'asset2/1/source',
      plainText: '바다로 떠나는 길',
      language: 'ko',
      segments: [{ seq: 0, startMs: 3_000, endMs: 5_000, text: '바다로 떠나는 길' }],
    },
    2_000,
  )

  // One stored window on asset1, with a thumbnail on disk.
  createSceneJob(
    db,
    {
      id: 'scene1',
      assetId: 'asset1',
      fileVersion: 1,
      modelId: 'facebook/pe-av-base-16-frame',
      modelRevision: 'commit-sha',
      modelSha256: SCENE_SHA,
      pipelineVersion: SCENE_PIPELINE,
      dimensions: DIMENSIONS,
      windowMs: 10_000,
      overlapMs: 2_000,
    },
    3_000,
  )
  claimSceneJob(db, 'scene-worker', 60_000, 3_000)
  await mkdir(path.join(cacheDir, 'scenes/asset1'), { recursive: true })
  await writeFile(path.join(cacheDir, 'scenes/asset1/0000.jpg'), 'jpeg')
  completeSceneJob(
    db,
    {
      jobId: 'scene1',
      owner: 'scene-worker',
      scenes: [
        {
          seq: 0,
          startMs: 0,
          endMs: 10_000,
          thumbnailPath: 'scenes/asset1/0000.jpg',
          visual: unit([1, 0, 0, 0]),
          audio: unit([0, 1, 0, 0]),
          av: unit([0, 0, 1, 0]),
        },
      ],
    },
    4_000,
  )

  let queryUrl = 'http://127.0.0.1:1'
  let stopQuery = () => {}
  if (options.query) {
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as { text?: string }
        const text = body.text ?? ''
        // "바다" points at the stored visual vector so the scene leg ranks it.
        const visual = text.includes('바다') ? [1, 0, 0, 0] : [0, 0, 1, 0]
        return Response.json({
          visual: encode(visual),
          audio: encode([0, 1, 0, 0]),
          av: encode([0, 0, 1, 0]),
          dimensions: DIMENSIONS,
        })
      },
    })
    servers.push(server)
    queryUrl = `http://127.0.0.1:${server.port}`
    stopQuery = () => server.stop(true)
  }

  const config: ApiConfig = {
    port: 0,
    host: '127.0.0.1',
    dataDir,
    cacheDir,
    mediaRoot: dataDir,
    authSecret: SECRET,
    accel: false,
    hwaccel: null,
    secureCookies: false,
    scanIntervalMs: 15 * 60_000,
    fileMutationEnabled: false,
    hlsGenerationsEnabled: false,
    trustProxy: [],
    publicOrigins: [],
    gpu: { resourceId: 'gpu:0' },
    asr: {
      enabled: false,
      workerToken: '',
      resultDir: dataDir,
      modelRevision: 'asr-rev',
      alignerRevision: 'align-rev',
      pipelineVersion: 'asr-1',
      retryMs: 15 * 60_000,
    },
    translation: {
      enabled: false,
      workerToken: '',
      resultDir: dataDir,
      modelId: 'model',
      modelRevision: 'commit-sha',
      modelSha256: 'sha',
      promptVersion: 'p1',
      pipelineVersion: 'tr-1',
      targetLanguage: 'ko',
    },
    embedding: {
      enabled: false,
      workerToken: '',
      modelId: 'model',
      modelRevision: 'commit-sha',
      modelSha256: 'sha',
      pipelineVersion: 'emb-1',
      dimensions: 2,
    },
    scene: {
      enabled: options.sceneEnabled ?? true,
      workerToken: options.sceneEnabled === false ? '' : SCENE_TOKEN,
      modelId: 'facebook/pe-av-base-16-frame',
      modelRevision: 'commit-sha',
      modelSha256: SCENE_SHA,
      pipelineVersion: SCENE_PIPELINE,
      dimensions: DIMENSIONS,
      windowMs: 10_000,
      overlapMs: 2_000,
      queryUrl,
    },
  }

  const ctx: AppContext = {
    config,
    db,
    thumbnails: new Semaphore(1),
    previews: new Semaphore(1),
  }
  const app = await buildApp(ctx)
  const token = createSession(db, 'user1', SECRET).token
  return { db, app, cookie: `${SESSION_COOKIE}=${token}`, cacheDir, queryUrl, stopQuery }
}

function auth(h: Harness): Record<string, string> {
  return { cookie: h.cookie }
}

describe('scene routes', () => {
  test('the stored windows come back with a thumbnail url', async () => {
    const h = await harness()
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/assets/asset1/scenes',
      headers: auth(h),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as { scenes: Array<{ id: string; startMs: number; thumbnailUrl: string }> }
    expect(body.scenes).toHaveLength(1)
    expect(body.scenes[0]?.startMs).toBe(0)
    expect(body.scenes[0]?.thumbnailUrl).toMatch(/^\/api\/scenes\/.+\/thumbnail$/)
  })

  test('a thumbnail is served from the cache volume', async () => {
    const h = await harness()
    const list = await h.app.inject({ method: 'GET', url: '/api/assets/asset1/scenes', headers: auth(h) })
    const sceneId = (list.json() as { scenes: Array<{ id: string }> }).scenes[0]!.id

    const response = await h.app.inject({
      method: 'GET',
      url: `/api/scenes/${sceneId}/thumbnail`,
      headers: auth(h),
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('image/jpeg')
  })

  test('an unknown scene has no thumbnail', async () => {
    const h = await harness()
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/scenes/missing/thumbnail',
      headers: auth(h),
    })

    expect(response.statusCode).toBe(404)
  })

  test('re-indexing is refused when scenes are not configured', async () => {
    const h = await harness({ sceneEnabled: false })
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/assets/asset1/scenes',
      headers: auth(h),
    })

    expect(response.statusCode).toBe(409)
  })

  test('re-indexing a video queues a job', async () => {
    const h = await harness()
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/assets/asset1/scenes',
      headers: auth(h),
    })

    expect(response.statusCode).toBe(202)
    expect((response.json() as { jobId: string }).jobId).toBeTruthy()
  })
})

describe('semantic search', () => {
  test('a visual query returns the stored window and the dialogue line', async () => {
    const h = await harness({ query: true })
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/search/semantic?q=바다',
      headers: auth(h),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      hits: Array<{ kind: string; assetId: string; source: string; startMs: number }>
      scenesSearched: boolean
    }
    expect(body.scenesSearched).toBe(true)
    expect(body.hits.some((hit) => hit.kind === 'scene' && hit.assetId === 'asset1')).toBe(true)
    expect(body.hits.some((hit) => hit.kind === 'dialogue' && hit.assetId === 'asset2')).toBe(true)
    expect(body.hits.find((hit) => hit.kind === 'scene')?.source).toBe('visual')
  })

  test('a scene result carries the second to seek to', async () => {
    const h = await harness({ query: true })
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/search/semantic?q=바다',
      headers: auth(h),
    })

    const body = response.json() as { hits: Array<{ kind: string; startMs: number; endMs: number }> }
    const scene = body.hits.find((hit) => hit.kind === 'scene')!
    expect(scene.startMs).toBe(0)
    expect(scene.endMs).toBe(10_000)
  })

  test('the text legs still answer when the query tower is down', async () => {
    const h = await harness({ query: false })
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/search/semantic?q=바다',
      headers: auth(h),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as { hits: Array<{ kind: string }>; scenesSearched: boolean }
    expect(body.scenesSearched).toBe(false)
    expect(body.hits.every((hit) => hit.kind === 'dialogue')).toBe(true)
  })

  test('a filename match is labelled as a title hit', async () => {
    const h = await harness()
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/search/semantic?q=asset1',
      headers: auth(h),
    })

    const body = response.json() as { hits: Array<{ kind: string; source: string }> }
    expect(body.hits[0]?.kind).toBe('asset')
    expect(body.hits[0]?.source).toBe('title')
  })

  test('an empty query is rejected', async () => {
    const h = await harness()
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/search/semantic?q=',
      headers: auth(h),
    })

    expect(response.statusCode).toBe(400)
  })
})

describe('worker scene lane', () => {
  async function queued(h: Harness): Promise<string> {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/assets/asset2/scenes',
      headers: auth(h),
    })
    return (response.json() as { jobId: string }).jobId
  }

  test('a wrong token is refused', async () => {
    const h = await harness()
    const response = await h.app.inject({
      method: 'POST',
      url: '/worker/scene/claim',
      headers: { 'x-worker-token': 'wrong-token-000000' },
      payload: { owner: 'scene-worker' },
    })

    expect(response.statusCode).toBe(401)
  })

  test('the indexer takes the shared gpu lease with its own token', async () => {
    const h = await harness()
    const acquired = await h.app.inject({
      method: 'POST',
      url: '/worker/gpu/acquire',
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload: { owner: 'scene-worker', taskKind: 'scene' },
    })
    expect(acquired.json().acquired).toBe(true)

    const wrong = await h.app.inject({
      method: 'POST',
      url: '/worker/gpu/acquire',
      headers: { 'x-worker-token': 'wrong-token-000000' },
      payload: { owner: 'other-worker', taskKind: 'scene' },
    })
    expect(wrong.statusCode).toBe(401)
    await h.app.close()
  })

  test('a claim carries the media path, the model and the window', async () => {
    const h = await harness()
    await queued(h)

    const response = await h.app.inject({
      method: 'POST',
      url: '/worker/scene/claim',
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload: { owner: 'scene-worker' },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      job: { assetId: string; dimensions: number }
      media: { path: string; filename: string; durationMs: number }
      model: { sha256: string; dimensions: number }
      window: { windowMs: number; overlapMs: number }
    }
    expect(body.job.assetId).toBe('asset2')
    expect(body.media.filename).toBe('asset2.mp4')
    expect(body.media.durationMs).toBe(60_000)
    expect(body.model.dimensions).toBe(DIMENSIONS)
    expect(body.window).toEqual({ windowMs: 10_000, overlapMs: 2_000 })
  })

  test('an empty queue answers with a null job', async () => {
    const h = await harness()
    const response = await h.app.inject({
      method: 'POST',
      url: '/worker/scene/claim',
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload: { owner: 'scene-worker' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.json() as { job: null }).job).toBeNull()
  })

  test('a vector that is not unit length is refused', async () => {
    const h = await harness()
    const jobId = await queued(h)
    await h.app.inject({
      method: 'POST',
      url: '/worker/scene/claim',
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload: { owner: 'scene-worker' },
    })

    const response = await h.app.inject({
      method: 'POST',
      url: `/worker/scene/jobs/${jobId}/complete`,
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload: {
        owner: 'scene-worker',
        scenes: [
          {
            seq: 0,
            startMs: 0,
            endMs: 10_000,
            thumbnailPath: null,
            visual: Buffer.from(Float32Array.from([2, 0, 0, 0]).buffer).toString('base64'),
            audio: encode([0, 1, 0, 0]),
            av: encode([0, 0, 1, 0]),
          },
        ],
      },
    })

    expect(response.statusCode).toBe(422)
    expect((response.json() as { error: string }).error).toBe('invalid_vector')
  })

  test('heartbeat, progress and complete keep the lease', async () => {
    const h = await harness()
    const jobId = await queued(h)
    await h.app.inject({
      method: 'POST',
      url: '/worker/scene/claim',
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload: { owner: 'scene-worker' },
    })

    const beat = await h.app.inject({
      method: 'POST',
      url: `/worker/scene/jobs/${jobId}/heartbeat`,
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload: { owner: 'scene-worker' },
    })
    expect(beat.statusCode).toBe(204)

    const progress = await h.app.inject({
      method: 'POST',
      url: `/worker/scene/jobs/${jobId}/progress`,
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload: { owner: 'scene-worker', state: 'embedding', stage: 'embedding', progress: 50 },
    })
    expect(progress.statusCode).toBe(204)

    const complete = await h.app.inject({
      method: 'POST',
      url: `/worker/scene/jobs/${jobId}/complete`,
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload: {
        owner: 'scene-worker',
        scenes: [
          {
            seq: 0,
            startMs: 0,
            endMs: 10_000,
            thumbnailPath: null,
            visual: encode([1, 0, 0, 0]),
            audio: encode([0, 1, 0, 0]),
            av: encode([0, 0, 1, 0]),
          },
        ],
      },
    })

    expect(complete.statusCode).toBe(200)
    expect((complete.json() as { scenes: number }).scenes).toBe(1)
  })

  test('a second complete from the same owner is a lost lease', async () => {
    const h = await harness()
    const jobId = await queued(h)
    await h.app.inject({
      method: 'POST',
      url: '/worker/scene/claim',
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload: { owner: 'scene-worker' },
    })
    const payload = {
      owner: 'scene-worker',
      scenes: [
        {
          seq: 0,
          startMs: 0,
          endMs: 10_000,
          thumbnailPath: null,
          visual: encode([1, 0, 0, 0]),
          audio: encode([0, 1, 0, 0]),
          av: encode([0, 0, 1, 0]),
        },
      ],
    }
    await h.app.inject({
      method: 'POST',
      url: `/worker/scene/jobs/${jobId}/complete`,
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload,
    })

    const again = await h.app.inject({
      method: 'POST',
      url: `/worker/scene/jobs/${jobId}/complete`,
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload,
    })

    expect(again.statusCode).toBe(409)
    expect((again.json() as { error: string }).error).toBe('lease_lost')
  })
})

describe('index pass', () => {
  test('a run queues a pass for every video that has none', async () => {
    const h = await harness()
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/index/run',
      headers: auth(h),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as { considered: number; scenes: number }
    expect(body.considered).toBe(2)
    // asset1 already has a scene pass; only asset2 needs it.
    expect(body.scenes).toBe(1)
  })

  test('a second run queues nothing', async () => {
    const h = await harness()
    await h.app.inject({ method: 'POST', url: '/api/index/run', headers: auth(h) })
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/index/run',
      headers: auth(h),
    })

    const body = response.json() as { scenes: number }
    expect(body.scenes).toBe(0)
  })

  test('the pass answers with counters when no lane is configured', async () => {
    const h = await harness({ sceneEnabled: false })
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/index/run',
      headers: auth(h),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ scenes: 0, asr: 0 })
  })
})
