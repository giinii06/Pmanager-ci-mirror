import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  completeAsrJob,
  createAsrJob,
  createLibrary,
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
const EMB_TOKEN = 'embedding-token-000000'
const EMB_SHA = 'sha-embed'
const EMB_PIPELINE = 'embed-1'
const DIMENSIONS = 2
const MODEL = 'asr-rev'
const ALIGNER = 'aligner-rev'
const ASR_PIPELINE = 'asr-1'

const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mediavault-emb-'))
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

function storeTranscript(db: Db, assetId: string, language = 'ko'): string {
  createAsrJob(
    db,
    {
      id: `asr-${assetId}`,
      assetId,
      fileVersion: 1,
      modelRevision: MODEL,
      alignerRevision: ALIGNER,
      pipelineVersion: ASR_PIPELINE,
    },
    1_000,
  )
  completeAsrJob(
    db,
    {
      jobId: `asr-${assetId}`,
      transcriptId: `tr-${assetId}`,
      resultDir: `${assetId}/1/source`,
      plainText: '바다에서 찍은 영상',
      language,
      segments: [
        { seq: 0, startMs: 0, endMs: 2_000, text: '바다에서 찍은 영상' },
        { seq: 1, startMs: 2_000, endMs: 4_000, text: '파도 소리' },
      ],
    },
    2_000,
  )
  return `tr-${assetId}`
}

interface Harness {
  db: Db
  app: Awaited<ReturnType<typeof buildApp>>
  cookie: string
}

async function harness(options: { transcripts?: boolean } = {}): Promise<Harness> {
  const dir = await makeDir()
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
  for (const id of ['asset1', 'asset2', 'asset3']) insertAsset(db, assetInput(id, folderId))
  if (options.transcripts !== false) {
    for (const id of ['asset1', 'asset2', 'asset3']) storeTranscript(db, id)
  }

  const config: ApiConfig = {
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    cacheDir: dir,
    mediaRoot: dir,
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
      resultDir: dir,
      modelRevision: MODEL,
      alignerRevision: ALIGNER,
      pipelineVersion: ASR_PIPELINE,
      retryMs: 15 * 60_000,
    },
    translation: {
      enabled: false,
      workerToken: '',
      resultDir: dir,
      modelId: 'IndexTeam/Index-Translate-9B-GGUF',
      modelRevision: 'commit-sha',
      modelSha256: 'sha-tr',
      promptVersion: '1',
      pipelineVersion: 'tr-1',
      targetLanguage: 'ko',
    },
    embedding: {
      enabled: true,
      workerToken: EMB_TOKEN,
      modelId: 'Qwen/Qwen3-Embedding-4B-GGUF',
      modelRevision: 'commit-sha',
      modelSha256: EMB_SHA,
      pipelineVersion: EMB_PIPELINE,
      dimensions: DIMENSIONS,
    },
    scene: {
      enabled: false,
      workerToken: '',
      modelId: 'facebook/pe-av-base-16-frame',
      modelRevision: 'main',
      modelSha256: 'scene-sha',
      pipelineVersion: 'scene-1',
      dimensions: 4,
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
  return { db, app, cookie: `${SESSION_COOKIE}=${token}` }
}

function worker(token = EMB_TOKEN): Record<string, string> {
  return { 'x-worker-token': token }
}

function encode(vector: number[]): string {
  return Buffer.from(Float32Array.from(vector).buffer).toString('base64')
}

function vector(kind: 'title' | 'chunk', chunkIndex: number, values: number[]) {
  return {
    kind,
    chunkIndex,
    startMs: chunkIndex * 2_000,
    endMs: chunkIndex * 2_000 + 2_000,
    text: `${kind} ${chunkIndex}`,
    vector: encode(values),
  }
}

async function claim(h: Harness): Promise<Record<string, unknown>> {
  const response = await h.app.inject({
    method: 'POST',
    url: '/worker/embedding/claim',
    headers: worker(),
    payload: { owner: 'worker-a' },
  })
  expect(response.statusCode).toBe(200)
  return response.json()
}

async function complete(
  h: Harness,
  jobId: string,
  vectors: unknown[],
  owner = 'worker-a',
): Promise<Awaited<ReturnType<Harness['app']['inject']>>> {
  return h.app.inject({
    method: 'POST',
    url: `/worker/embedding/jobs/${jobId}/complete`,
    headers: worker(),
    payload: { owner, vectors },
  })
}

describe('embedding worker routes', () => {
  test('the claim carries the asset, the cues and the model fingerprint', async () => {
    const h = await harness()
    await h.app.inject({
      method: 'POST',
      url: '/api/assets/asset1/embedding',
      headers: { cookie: h.cookie },
    })

    const body = await claim(h)

    expect(body.job).toMatchObject({ assetId: 'asset1', state: 'embedding', stage: 'starting' })
    expect(body.asset).toEqual({ id: 'asset1', filename: 'asset1.mp4', fileVersion: 1 })
    expect(body.text).toEqual({
      language: 'ko',
      transcriptId: 'tr-asset1',
      segments: [
        { startMs: 0, endMs: 2_000, text: '바다에서 찍은 영상' },
        { startMs: 2_000, endMs: 4_000, text: '파도 소리' },
      ],
    })
    expect(body.model).toEqual({
      id: 'Qwen/Qwen3-Embedding-4B-GGUF',
      revision: 'commit-sha',
      sha256: EMB_SHA,
      pipelineVersion: EMB_PIPELINE,
      dimensions: DIMENSIONS,
    })
    await h.app.close()
  })

  test('a video with no transcript claims with an empty text block', async () => {
    const h = await harness({ transcripts: false })
    await h.app.inject({
      method: 'POST',
      url: '/api/assets/asset1/embedding',
      headers: { cookie: h.cookie },
    })

    const body = await claim(h)

    expect(body.text).toEqual({ language: null, transcriptId: null, segments: [] })
    await h.app.close()
  })

  test('complete stores the vectors and related ranks by similarity', async () => {
    const h = await harness()
    await h.app.inject({
      method: 'POST',
      url: '/api/assets/asset1/embedding',
      headers: { cookie: h.cookie },
    })
    const job = (await claim(h)).job as { id: string }
    const stored = await complete(h, job.id, [vector('chunk', 0, [1, 0])])
    expect(stored.statusCode).toBe(200)
    expect(stored.json()).toEqual({ embedded: 1 })

    for (const [assetId, values] of [
      ['asset2', [0.6, 0.8]],
      ['asset3', [0, 1]],
    ] as const) {
      await h.app.inject({
        method: 'POST',
        url: `/api/assets/${assetId}/embedding`,
        headers: { cookie: h.cookie },
      })
      const next = (await claim(h)).job as { id: string }
      expect((await complete(h, next.id, [vector('chunk', 0, [...values])])).statusCode).toBe(200)
    }

    const related = await h.app.inject({
      method: 'GET',
      url: '/api/assets/asset1/related',
      headers: { cookie: h.cookie },
    })
    expect(related.statusCode).toBe(200)
    expect(related.json().basis).toBe('semantic')
    expect(related.json().items.map((item: { id: string }) => item.id)).toEqual([
      'asset2',
      'asset3',
    ])
    await h.app.close()
  })

  test('complete rejects a vector of the wrong length', async () => {
    const h = await harness()
    await h.app.inject({
      method: 'POST',
      url: '/api/assets/asset1/embedding',
      headers: { cookie: h.cookie },
    })
    const job = (await claim(h)).job as { id: string }

    const rejected = await complete(h, job.id, [vector('chunk', 0, [1, 0, 0])])

    expect(rejected.statusCode).toBe(422)
    expect(rejected.json().error).toBe('invalid_vector')
    await h.app.close()
  })

  test('complete rejects a vector holding a non-finite value', async () => {
    const h = await harness()
    await h.app.inject({
      method: 'POST',
      url: '/api/assets/asset1/embedding',
      headers: { cookie: h.cookie },
    })
    const job = (await claim(h)).job as { id: string }

    const rejected = await complete(h, job.id, [vector('chunk', 0, [Number.NaN, 0])])

    expect(rejected.statusCode).toBe(422)
    expect(rejected.json().error).toBe('invalid_vector')
    await h.app.close()
  })

  test('complete answers 409 once the lease moved to another worker', async () => {
    const h = await harness()
    await h.app.inject({
      method: 'POST',
      url: '/api/assets/asset1/embedding',
      headers: { cookie: h.cookie },
    })
    const job = (await claim(h)).job as { id: string }

    const rejected = await complete(h, job.id, [vector('chunk', 0, [1, 0])], 'worker-b')

    expect(rejected.statusCode).toBe(409)
    expect(rejected.json().error).toBe('lease_lost')
    await h.app.close()
  })

  test('a missing worker token is rejected', async () => {
    const h = await harness()
    const response = await h.app.inject({
      method: 'POST',
      url: '/worker/embedding/claim',
      payload: { owner: 'worker-a' },
    })
    expect(response.statusCode).toBe(401)
    await h.app.close()
  })

  test('related falls back to the folder order before any vector exists', async () => {
    const h = await harness()

    const queued = await h.app.inject({
      method: 'POST',
      url: '/api/assets/asset1/embedding',
      headers: { cookie: h.cookie },
    })
    expect(queued.statusCode).toBe(202)
    expect(queued.json().job.state).toBe('queued')

    const related = await h.app.inject({
      method: 'GET',
      url: '/api/assets/asset1/related',
      headers: { cookie: h.cookie },
    })
    expect(related.statusCode).toBe(200)
    expect(related.json().basis).toBe('folder')
    expect(related.json().items.map((item: { id: string }) => item.id).sort()).toEqual([
      'asset2',
      'asset3',
    ])
    await h.app.close()
  })
})
