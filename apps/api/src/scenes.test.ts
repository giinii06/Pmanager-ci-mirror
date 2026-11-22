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
  getSceneJob,
  getStageCheckpoint,
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

afterAll(async () => {
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

interface Harness {
  db: Db
  app: Awaited<ReturnType<typeof buildApp>>
  cookie: string
  cacheDir: string
}

async function harness(options: { sceneEnabled?: boolean } = {}): Promise<Harness> {
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
    smartAlbumsEnabled: false,
    trustProxy: [],
    publicOrigins: [],
    gpu: { resourceId: 'gpu:0' },
    search: { ftsEnabled: false },
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
      maxWindows: 120,
      queryUrl: 'http://127.0.0.1:1',
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
  return { db, app, cookie: `${SESSION_COOKIE}=${token}`, cacheDir }
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

describe('filename-only search alongside scene processing', () => {
  test('only the filename matches; scene vectors and dialogue text do not affect global search', async () => {
    const h = await harness()

    const filename = await h.app.inject({
      method: 'GET',
      url: '/api/assets?q=asset1',
      headers: auth(h),
    })
    expect(filename.statusCode).toBe(200)
    expect((filename.json() as { total: number; items: Array<{ filename: string }> }).total).toBe(1)
    expect((filename.json() as { items: Array<{ filename: string }> }).items[0]?.filename).toBe('asset1.mp4')

    // The ASR fixture contains "바다", but neither filename contains it.
    const dialogue = await h.app.inject({
      method: 'GET',
      url: '/api/assets?q=' + encodeURIComponent('바다'),
      headers: auth(h),
    })
    expect(dialogue.statusCode).toBe(200)
    expect((dialogue.json() as { total: number }).total).toBe(0)

    const retired = await h.app.inject({
      method: 'GET',
      url: '/api/search/semantic?q=asset1',
      headers: auth(h),
    })
    expect(retired.statusCode).toBe(404)

    const scenes = await h.app.inject({
      method: 'GET',
      url: '/api/assets/asset1/scenes',
      headers: auth(h),
    })
    expect(scenes.statusCode).toBe(200)
    expect((scenes.json() as { scenes: Array<{ id: string }> }).scenes).toHaveLength(1)
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
      payload: { owner: 'scene-worker', taskKind: 'scene', acquisitionId: 'scene-worker-acquire-0123456789' },
    })
    expect(acquired.json().acquired).toBe(true)

    const wrong = await h.app.inject({
      method: 'POST',
      url: '/worker/gpu/acquire',
      headers: { 'x-worker-token': 'wrong-token-000000' },
      payload: { owner: 'other-worker', taskKind: 'scene', acquisitionId: 'other-worker-acquire-0123456789' },
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

  test('a checkpoint is stored and offered to the next claim', async () => {
    const h = await harness()
    const jobId = await queued(h)
    const first = await h.app.inject({
      method: 'POST',
      url: '/worker/scene/claim',
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload: { owner: 'scene-worker' },
    })
    expect((first.json() as { checkpoint: unknown }).checkpoint).toBeNull()

    const manifestPath = '/cache/scene-checkpoints/job1/manifest.json'
    const manifestHash = 'a'.repeat(64)
    const saved = await h.app.inject({
      method: 'POST',
      url: `/worker/scene/jobs/${jobId}/checkpoint`,
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload: {
        owner: 'scene-worker',
        stage: 'extracting',
        completedUnits: 5,
        totalUnits: 6,
        manifestPath,
        manifestHash,
      },
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toEqual({ checkpoint: { completedUnits: 5, totalUnits: 6 } })
    expect(getStageCheckpoint(h.db, jobId, 'extracting')?.manifestHash).toBe(manifestHash)

    // Hand the job back untouched, like a worker that stopped mid-stage.
    h.db
      .query(
        "UPDATE scene_jobs SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL WHERE id = ?",
      )
      .run(jobId)

    const second = await h.app.inject({
      method: 'POST',
      url: '/worker/scene/claim',
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload: { owner: 'scene-worker' },
    })
    const body = second.json() as { checkpoint: unknown }
    expect(body.checkpoint).toEqual({
      stage: 'extracting',
      completedUnits: 5,
      totalUnits: 6,
      manifestPath,
      manifestHash,
    })
  })

  test('a checkpoint from another owner is a lost lease', async () => {
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
      url: `/worker/scene/jobs/${jobId}/checkpoint`,
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload: {
        owner: 'other-worker',
        stage: 'extracting',
        completedUnits: 1,
        totalUnits: 6,
        manifestPath: '/cache/scene-checkpoints/job1/manifest.json',
        manifestHash: 'b'.repeat(64),
      },
    })

    expect(response.statusCode).toBe(409)
  })

  test('more completed units than the plan is refused', async () => {
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
      url: `/worker/scene/jobs/${jobId}/checkpoint`,
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload: {
        owner: 'scene-worker',
        stage: 'extracting',
        completedUnits: 7,
        totalUnits: 6,
        manifestPath: '/cache/scene-checkpoints/job1/manifest.json',
        manifestHash: 'c'.repeat(64),
      },
    })

    expect(response.statusCode).toBe(422)
    expect((response.json() as { error: string }).error).toBe('invalid_checkpoint')
  })

  test('a checkpoint from another model is dropped instead of reused', async () => {
    const h = await harness()
    const jobId = await queued(h)
    await h.app.inject({
      method: 'POST',
      url: '/worker/scene/claim',
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload: { owner: 'scene-worker' },
    })
    await h.app.inject({
      method: 'POST',
      url: `/worker/scene/jobs/${jobId}/checkpoint`,
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload: {
        owner: 'scene-worker',
        stage: 'extracting',
        completedUnits: 5,
        totalUnits: 6,
        manifestPath: '/cache/scene-checkpoints/job1/manifest.json',
        manifestHash: 'd'.repeat(64),
      },
    })

    h.db
      .query(
        "UPDATE scene_jobs SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL, model_sha256 = 'another-sha' WHERE id = ?",
      )
      .run(jobId)
    const claim = await h.app.inject({
      method: 'POST',
      url: '/worker/scene/claim',
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload: { owner: 'scene-worker' },
    })

    expect((claim.json() as { checkpoint: unknown }).checkpoint).toBeNull()
    expect(getStageCheckpoint(h.db, jobId, 'extracting')).toBeNull()
  })

  test('completion stores the coverage and clears the checkpoint', async () => {
    const h = await harness()
    const jobId = await queued(h)
    await h.app.inject({
      method: 'POST',
      url: '/worker/scene/claim',
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload: { owner: 'scene-worker' },
    })
    await h.app.inject({
      method: 'POST',
      url: `/worker/scene/jobs/${jobId}/checkpoint`,
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload: {
        owner: 'scene-worker',
        stage: 'extracting',
        completedUnits: 5,
        totalUnits: 6,
        manifestPath: '/cache/scene-checkpoints/job1/manifest.json',
        manifestHash: 'e'.repeat(64),
      },
    })

    const complete = await h.app.inject({
      method: 'POST',
      url: `/worker/scene/jobs/${jobId}/complete`,
      headers: { 'x-worker-token': SCENE_TOKEN },
      payload: {
        owner: 'scene-worker',
        coverage: { analyzed: 5, total: 6 },
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

    const job = getSceneJob(h.db, jobId)
    expect(job?.analyzedWindows).toBe(5)
    expect(job?.totalWindows).toBe(6)
    expect(getStageCheckpoint(h.db, jobId, 'extracting')).toBeNull()

    const list = await h.app.inject({
      method: 'GET',
      url: '/api/assets/asset2/scenes',
      headers: auth(h),
    })
    expect((list.json() as { coverage: unknown }).coverage).toEqual({ analyzed: 5, total: 6 })
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
