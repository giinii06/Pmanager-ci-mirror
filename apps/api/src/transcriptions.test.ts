import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  activeTranslationJob,
  claimAsrJob,
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
const ASR_TOKEN = 'asr-worker-token-000000'
const TR_TOKEN = 'translation-token-000000'
const MODEL = 'asr-rev'
const ALIGNER = 'aligner-rev'
const ASR_PIPELINE = 'asr-1'
const SHA = 'sha-q4'
const PROMPT = 'prompt-1'
const TR_PIPELINE = 'tr-1'

const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mediavault-asr-'))
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

interface Harness {
  db: Db
  app: Awaited<ReturnType<typeof buildApp>>
  cookie: string
}

/** A claimed ASR job for the one asset, so the worker route can complete it. */
async function harness(): Promise<Harness> {
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
  insertAsset(db, assetInput('asset1', folderId))

  createAsrJob(
    db,
    {
      id: 'asr1',
      assetId: 'asset1',
      fileVersion: 1,
      modelRevision: MODEL,
      alignerRevision: ALIGNER,
      pipelineVersion: ASR_PIPELINE,
    },
    1_000,
  )
  claimAsrJob(db, 'worker-a', 120_000, 1_100)

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
    search: { ftsEnabled: false },
    asr: {
      enabled: true,
      workerToken: ASR_TOKEN,
      resultDir: dir,
      modelRevision: MODEL,
      alignerRevision: ALIGNER,
      pipelineVersion: ASR_PIPELINE,
      retryMs: 15 * 60_000,
    },
    translation: {
      enabled: true,
      workerToken: TR_TOKEN,
      resultDir: dir,
      modelId: 'IndexTeam/Index-Translate-9B-GGUF',
      modelRevision: 'commit-sha',
      modelSha256: SHA,
      promptVersion: PROMPT,
      pipelineVersion: TR_PIPELINE,
      targetLanguage: 'ko',
    },
    embedding: {
      enabled: false,
      workerToken: '',
      modelId: 'Qwen/Qwen3-Embedding-4B-GGUF',
      modelRevision: 'commit-sha',
      modelSha256: 'sha-embed',
      pipelineVersion: 'embed-1',
      dimensions: 2,
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

  const ctx: AppContext = { config, db, thumbnails: new Semaphore(1), previews: new Semaphore(1) }
  const app = await buildApp(ctx)
  const token = createSession(db, 'user1', SECRET).token
  return { db, app, cookie: `${SESSION_COOKIE}=${token}` }
}

function complete(h: Harness, payload: Record<string, unknown>) {
  return h.app.inject({
    method: 'POST',
    url: '/worker/asr/jobs/asr1/complete',
    headers: { 'x-worker-token': ASR_TOKEN },
    payload: { owner: 'worker-a', transcriptId: 'transcript1', resultDir: 'asset1/1/key', ...payload },
  })
}

const NO_SPEECH = { hasSpeech: false, language: '', plainText: '', segments: [] }

describe('no-speech transcripts', () => {
  test('the complete route refuses a no-speech transcript that carries cues', async () => {
    const h = await harness()
    const rejected = await complete(h, {
      ...NO_SPEECH,
      segments: [{ startMs: 0, endMs: 1_000, text: '안녕하세요' }],
    })

    expect(rejected.statusCode).toBe(400)
    expect(rejected.json().error).toBe('invalid_request')
    expect(rejected.json().message).toContain('segments')

    const status = await h.app.inject({
      method: 'GET',
      url: '/api/assets/asset1/transcription/status',
      headers: { cookie: h.cookie },
    })
    expect(status.json().transcript).toBeNull()
    await h.app.close()
  })

  test('a file with no speech reads as a property, not a failure', async () => {
    const h = await harness()
    const done = await complete(h, NO_SPEECH)
    expect(done.statusCode).toBe(200)

    const status = await h.app.inject({
      method: 'GET',
      url: '/api/assets/asset1/transcription/status',
      headers: { cookie: h.cookie },
    })
    expect(status.json().job.state).toBe('completed')
    expect(status.json().transcript.hasSpeech).toBe(false)
    expect(status.json().transcript.language).toBeNull()
    expect(status.json().transcript.segmentCount).toBe(0)

    const detail = await h.app.inject({
      method: 'GET',
      url: '/api/assets/asset1/transcription',
      headers: { cookie: h.cookie },
    })
    expect(detail.json().hasSpeech).toBe(false)
    expect(detail.json().language).toBeNull()
    expect(detail.json().segments).toEqual([])

    const tracks = await h.app.inject({
      method: 'GET',
      url: '/api/assets/asset1/subtitle-tracks',
      headers: { cookie: h.cookie },
    })
    expect(tracks.json()).toEqual({ tracks: [], defaultLanguage: null })

    const vtt = await h.app.inject({
      method: 'GET',
      url: '/api/assets/asset1/subtitles.vtt',
      headers: { cookie: h.cookie },
    })
    expect(vtt.statusCode).toBe(404)

    expect(activeTranslationJob(h.db, done.json().transcriptId, 'ko')).toBeNull()
    const requested = await h.app.inject({
      method: 'POST',
      url: '/api/assets/asset1/translations',
      headers: { cookie: h.cookie },
      payload: {},
    })
    expect(requested.json()).toEqual({ job: null, translation: null })
    await h.app.close()
  })
})

describe('an unknown spoken language', () => {
  test('a speech transcript without a language is stored instead of rejected', async () => {
    const h = await harness()
    const done = await complete(h, {
      language: '',
      plainText: '안녕하세요',
      segments: [{ startMs: 0, endMs: 1_000, text: '안녕하세요' }],
    })
    expect(done.statusCode).toBe(200)

    const status = await h.app.inject({
      method: 'GET',
      url: '/api/assets/asset1/transcription/status',
      headers: { cookie: h.cookie },
    })
    expect(status.json().job.state).toBe('completed')
    expect(status.json().transcript.hasSpeech).toBe(true)
    expect(status.json().transcript.language).toBe('')
    expect(status.json().transcript.segmentCount).toBe(1)

    // The translation lane still runs, so an unlabelled transcript is not a
    // dead end for the file.
    expect(activeTranslationJob(h.db, done.json().transcriptId, 'ko')).not.toBeNull()
    await h.app.close()
  })

  test('a completion larger than the global 1 MB limit is accepted', async () => {
    const h = await harness()
    const done = await complete(h, {
      language: 'ko',
      plainText: '가'.repeat(1_200_000),
      segments: [{ startMs: 0, endMs: 1_000, text: '안녕하세요' }],
    })
    expect(done.statusCode).toBe(200)
    await h.app.close()
  })
})
