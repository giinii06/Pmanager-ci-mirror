import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  activeTranslationJob,
  claimAsrJob,
  completeAsrJob,
  completeTranslationJob,
  createAsrJob,
  createLibrary,
  createTranslationJob,
  createUser,
  claimTranslationJob,
  insertAsset,
  openDatabase,
  upsertFolder,
  type Db,
} from '@mediavault/database'
import type { NewAsset } from '@mediavault/database'
import { buildApp } from './app'
import { SESSION_COOKIE, createSessionToken } from './auth'
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
  const dir = await mkdtemp(path.join(tmpdir(), 'mediavault-tr-'))
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
  asrDir: string
  trDir: string
}

async function harness(language = 'ja'): Promise<Harness> {
  const asrDir = await makeDir()
  const trDir = await makeDir()
  const db = openDatabase(':memory:')

  createUser(db, {
    id: 'user1',
    username: 'owner',
    passwordHash: 'x',
    createdAt: 1,
  })
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
  completeAsrJob(
    db,
    {
      jobId: 'asr1',
      transcriptId: 'transcript1',
      resultDir: 'asset1/1/source',
      plainText: 'それ、マジでやばくない？ 本当に？',
      language,
      segments: [
        { seq: 0, startMs: 0, endMs: 2_000, text: 'それ、マジでやばくない？' },
        { seq: 1, startMs: 2_000, endMs: 4_000, text: '本当に？' },
      ],
    },
    2_000,
  )
  await mkdir(path.join(asrDir, 'asset1/1/source'), { recursive: true })
  await writeFile(
    path.join(asrDir, 'asset1/1/source/subtitles.vtt'),
    'WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nそれ、マジでやばくない？\n',
  )

  const config: ApiConfig = {
    port: 0,
    host: '127.0.0.1',
    dataDir: asrDir,
    cacheDir: asrDir,
    mediaRoot: asrDir,
    authSecret: SECRET,
    accel: false,
    hwaccel: null,
    secureCookies: false,
    asr: {
      enabled: true,
      workerToken: ASR_TOKEN,
      resultDir: asrDir,
      modelRevision: MODEL,
      alignerRevision: ALIGNER,
      pipelineVersion: ASR_PIPELINE,
    },
    translation: {
      enabled: true,
      workerToken: TR_TOKEN,
      resultDir: trDir,
      modelId: 'IndexTeam/Index-Translate-9B-GGUF',
      modelRevision: 'commit-sha',
      modelSha256: SHA,
      promptVersion: PROMPT,
      pipelineVersion: TR_PIPELINE,
      targetLanguage: 'ko',
      gpuResource: 'gpu:0',
    },
  }

  const ctx: AppContext = {
    config,
    db,
    thumbnails: new Semaphore(1),
    previews: new Semaphore(1),
  }
  const app = await buildApp(ctx)
  const token = createSessionToken('user1', SECRET)
  return { db, app, cookie: `${SESSION_COOKIE}=${token}`, asrDir, trDir }
}

function auth(h: Harness): Record<string, string> {
  return { cookie: h.cookie }
}

function worker(token = TR_TOKEN): Record<string, string> {
  return { 'x-worker-token': token }
}

interface StoredTranslation {
  id: string
  targetLanguage: string
  modelSha256: string
  text: string
}

/**
 * Runs a translation job to completion and writes the cues file the worker
 * would have produced, so a stored translation is both a row and a servable VTT.
 */
async function storeTranslation(h: Harness, input: StoredTranslation): Promise<void> {
  const job = createTranslationJob(
    h.db,
    {
      id: `${input.id}-job`,
      sourceTranscriptId: 'transcript1',
      assetId: 'asset1',
      fileVersion: 1,
      sourceLanguage: 'ko',
      targetLanguage: input.targetLanguage,
      modelId: 'IndexTeam/Index-Translate-9B-GGUF',
      modelRevision: 'commit-sha',
      modelSha256: input.modelSha256,
      promptVersion: PROMPT,
      pipelineVersion: TR_PIPELINE,
    },
    3_000,
  )
  claimTranslationJob(h.db, 'worker-a', 60_000, 3_100)
  completeTranslationJob(
    h.db,
    {
      jobId: job.id,
      owner: 'worker-a',
      translationId: input.id,
      resultDir: `asset1/1/translations/transcript1/${input.targetLanguage}/fp`,
      plainText: input.text,
      segments: [
        { seq: 0, startMs: 0, endMs: 2_000, text: 'それ、マジでやばくない？' },
        { seq: 1, startMs: 2_000, endMs: 4_000, text: '本当に？' },
      ],
    },
    3_200,
  )
  const dir = path.join(h.trDir, `asset1/1/translations/transcript1/${input.targetLanguage}/fp`)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'subtitles.vtt'),
    `WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\n${input.text}\n`,
  )
}

describe('translation routes', () => {
  test('a non-Korean transcript offers a translation track that starts empty', async () => {
    const h = await harness('ja')
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/assets/asset1/subtitle-tracks',
      headers: auth(h),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      tracks: [
        { language: 'ja', source: 'asr', ready: true },
        { language: 'ko', source: 'translation', ready: false },
      ],
      defaultLanguage: 'original',
    })
    await h.app.close()
  })

  test('a Korean transcript needs no translation job', async () => {
    const h = await harness('ko')
    const tracks = await h.app.inject({
      method: 'GET',
      url: '/api/assets/asset1/subtitle-tracks',
      headers: auth(h),
    })
    expect(tracks.json()).toEqual({
      tracks: [{ language: 'ko', source: 'asr', ready: true }],
      defaultLanguage: 'original',
    })

    const created = await h.app.inject({
      method: 'POST',
      url: '/api/assets/asset1/translations',
      headers: auth(h),
      payload: {},
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toEqual({ job: null, translation: null })
    await h.app.close()
  })

  test('a Korean transcript with a current English translation lists both tracks', async () => {
    const h = await harness('ko')
    await storeTranslation(h, {
      id: 'translation-en',
      targetLanguage: 'en',
      modelSha256: SHA,
      text: 'Really?',
    })

    const tracks = await h.app.inject({
      method: 'GET',
      url: '/api/assets/asset1/subtitle-tracks',
      headers: auth(h),
    })
    expect(tracks.json()).toEqual({
      tracks: [
        { language: 'ko', source: 'asr', ready: true },
        { language: 'en', source: 'translation', ready: true },
      ],
      defaultLanguage: 'original',
    })

    const english = await h.app.inject({
      method: 'GET',
      url: '/api/assets/asset1/subtitles.vtt?lang=en',
      headers: auth(h),
    })
    expect(english.statusCode).toBe(200)
    expect(english.body).toContain('Really?')
    await h.app.close()
  })

  test('a translation from an older model adds no track', async () => {
    const h = await harness('ko')
    await storeTranslation(h, {
      id: 'translation-en',
      targetLanguage: 'en',
      modelSha256: 'sha-old',
      text: 'Really?',
    })

    const tracks = await h.app.inject({
      method: 'GET',
      url: '/api/assets/asset1/subtitle-tracks',
      headers: auth(h),
    })
    expect(tracks.json()).toEqual({
      tracks: [{ language: 'ko', source: 'asr', ready: true }],
      defaultLanguage: 'original',
    })
    await h.app.close()
  })

  test('the worker claim carries the source cues and the model fingerprint', async () => {
    const h = await harness('ja')
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/assets/asset1/translations',
      headers: auth(h),
      payload: {},
    })
    expect(created.statusCode).toBe(202)
    expect(created.json().job.state).toBe('queued')

    const claim = await h.app.inject({
      method: 'POST',
      url: '/worker/translation/claim',
      headers: worker(),
      payload: { owner: 'worker-a' },
    })
    expect(claim.statusCode).toBe(200)
    const body = claim.json()
    expect(body.source.segments).toEqual([
      { seq: 0, startMs: 0, endMs: 2_000, text: 'それ、マジでやばくない？' },
      { seq: 1, startMs: 2_000, endMs: 4_000, text: '本当に？' },
    ])
    expect(body.model.sha256).toBe(SHA)
    await h.app.close()
  })

  test('complete rejects cues that do not match the source timings', async () => {
    const h = await harness('ja')
    await h.app.inject({
      method: 'POST',
      url: '/api/assets/asset1/translations',
      headers: auth(h),
      payload: {},
    })
    const claim = await h.app.inject({
      method: 'POST',
      url: '/worker/translation/claim',
      headers: worker(),
      payload: { owner: 'worker-a' },
    })
    const jobId = claim.json().job.id

    const bad = await h.app.inject({
      method: 'POST',
      url: `/worker/translation/jobs/${jobId}/complete`,
      headers: worker(),
      payload: {
        owner: 'worker-a',
        translationId: 'translation1',
        resultDir: 'asset1/1/translations/transcript1/ko/fp',
        plainText: '저기, 진짜 심각하지 않아? 정말?',
        segments: [
          { seq: 0, startMs: 0, endMs: 1_500, text: '저기, 진짜 심각하지 않아?' },
          { seq: 1, startMs: 2_000, endMs: 4_000, text: '정말?' },
        ],
      },
    })

    expect(bad.statusCode).toBe(422)
    expect(bad.json().error).toBe('segment_mismatch')
    await h.app.close()
  })

  test('a completed translation becomes the default track and serves its VTT', async () => {
    const h = await harness('ja')
    await h.app.inject({
      method: 'POST',
      url: '/api/assets/asset1/translations',
      headers: auth(h),
      payload: {},
    })
    const claim = await h.app.inject({
      method: 'POST',
      url: '/worker/translation/claim',
      headers: worker(),
      payload: { owner: 'worker-a' },
    })
    const jobId = claim.json().job.id

    const done = await h.app.inject({
      method: 'POST',
      url: `/worker/translation/jobs/${jobId}/complete`,
      headers: worker(),
      payload: {
        owner: 'worker-a',
        translationId: 'translation1',
        resultDir: 'asset1/1/translations/transcript1/ko/fp',
        plainText: '저기, 진짜 심각하지 않아? 정말?',
        segments: [
          { seq: 0, startMs: 0, endMs: 2_000, text: '저기, 진짜 심각하지 않아?' },
          { seq: 1, startMs: 2_000, endMs: 4_000, text: '정말?' },
        ],
      },
    })
    expect(done.statusCode).toBe(200)
    expect(done.json().translationId).toBe('translation1')

    const vttDir = path.join(h.trDir, 'asset1/1/translations/transcript1/ko/fp')
    await mkdir(vttDir, { recursive: true })
    await writeFile(
      path.join(vttDir, 'subtitles.vtt'),
      'WEBVTT\n\n1\n00:00:00.000 --> 00:00:04.000\n저기, 진짜 심각하지 않아?\n정말?\n',
    )

    const tracks = await h.app.inject({
      method: 'GET',
      url: '/api/assets/asset1/subtitle-tracks',
      headers: auth(h),
    })
    expect(tracks.json()).toEqual({
      tracks: [
        { language: 'ja', source: 'asr', ready: true },
        { language: 'ko', source: 'translation', ready: true },
      ],
      defaultLanguage: 'ko',
    })

    const korean = await h.app.inject({
      method: 'GET',
      url: '/api/assets/asset1/subtitles.vtt?lang=ko',
      headers: auth(h),
    })
    expect(korean.statusCode).toBe(200)
    expect(korean.headers['content-type']).toContain('text/vtt')
    expect(korean.body).toContain('저기, 진짜 심각하지 않아?')

    const source = await h.app.inject({
      method: 'GET',
      url: '/api/assets/asset1/subtitles.vtt',
      headers: auth(h),
    })
    expect(source.statusCode).toBe(200)
    expect(source.body).toContain('それ、マジでやばくない？')

    const detail = await h.app.inject({
      method: 'GET',
      url: '/api/assets/asset1/translation?lang=ko',
      headers: auth(h),
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().segments).toHaveLength(2)

    const search = await h.app.inject({
      method: 'GET',
      url: '/api/assets/asset1/transcript/search?q=%EC%A7%84%EC%A7%9C&lang=ko',
      headers: auth(h),
    })
    expect(search.json().hits).toHaveLength(1)
    expect(search.json().hits[0].text).toContain('진짜')

    const again = await h.app.inject({
      method: 'POST',
      url: '/api/assets/asset1/translations',
      headers: auth(h),
      payload: {},
    })
    expect(again.statusCode).toBe(200)
    expect(again.json().job).toBeNull()
    expect(again.json().translation.id).toBe('translation1')
    await h.app.close()
  })

  test('the worker routes reject a missing token', async () => {
    const h = await harness('ja')
    const claim = await h.app.inject({
      method: 'POST',
      url: '/worker/translation/claim',
      payload: { owner: 'worker-a' },
    })
    expect(claim.statusCode).toBe(401)
    await h.app.close()
  })

  test('ASR completion enqueues a translation for a non-Korean source', async () => {
    const h = await harness('ja')
    createAsrJob(
      h.db,
      {
        id: 'asr2',
        assetId: 'asset1',
        fileVersion: 2,
        modelRevision: MODEL,
        alignerRevision: ALIGNER,
        pipelineVersion: ASR_PIPELINE,
      },
      5_000,
    )
    claimAsrJob(h.db, 'worker-a', 120_000, 5_100)

    const done = await h.app.inject({
      method: 'POST',
      url: '/worker/asr/jobs/asr2/complete',
      headers: { 'x-worker-token': ASR_TOKEN },
      payload: {
        owner: 'worker-a',
        transcriptId: 'transcript2',
        resultDir: 'asset1/2/source',
        plainText: 'それ、マジでやばくない？',
        language: 'ja',
        segments: [{ startMs: 0, endMs: 2_000, text: 'それ、マジでやばくない？' }],
      },
    })

    expect(done.statusCode).toBe(200)
    const job = activeTranslationJob(h.db, 'transcript2', 'ko')
    expect(job?.state).toBe('queued')
    expect(job?.sourceLanguage).toBe('ja')
    await h.app.close()
  })

  test('ASR completion skips the translation when the source is Korean', async () => {
    const h = await harness('ja')
    createAsrJob(
      h.db,
      {
        id: 'asr2',
        assetId: 'asset1',
        fileVersion: 2,
        modelRevision: MODEL,
        alignerRevision: ALIGNER,
        pipelineVersion: ASR_PIPELINE,
      },
      5_000,
    )
    claimAsrJob(h.db, 'worker-a', 120_000, 5_100)

    const done = await h.app.inject({
      method: 'POST',
      url: '/worker/asr/jobs/asr2/complete',
      headers: { 'x-worker-token': ASR_TOKEN },
      payload: {
        owner: 'worker-a',
        transcriptId: 'transcript2',
        resultDir: 'asset1/2/source',
        plainText: '안녕하세요',
        language: 'ko',
        segments: [{ startMs: 0, endMs: 2_000, text: '안녕하세요' }],
      },
    })

    expect(done.statusCode).toBe(200)
    expect(activeTranslationJob(h.db, 'transcript2', 'ko')).toBeNull()
    await h.app.close()
  })

  test('the gpu lease is held by one worker at a time', async () => {
    const h = await harness('ja')
    const first = await h.app.inject({
      method: 'POST',
      url: '/worker/gpu/acquire',
      headers: worker(),
      payload: { owner: 'worker-a', taskKind: 'translation' },
    })
    expect(first.json().acquired).toBe(true)

    const second = await h.app.inject({
      method: 'POST',
      url: '/worker/gpu/acquire',
      headers: worker(),
      payload: { owner: 'worker-b', taskKind: 'translation' },
    })
    expect(second.json().acquired).toBe(false)

    const released = await h.app.inject({
      method: 'POST',
      url: '/worker/gpu/release',
      headers: worker(),
      payload: { owner: 'worker-a' },
    })
    expect(released.statusCode).toBe(204)

    const third = await h.app.inject({
      method: 'POST',
      url: '/worker/gpu/acquire',
      headers: worker(),
      payload: { owner: 'worker-b', taskKind: 'translation' },
    })
    expect(third.json().acquired).toBe(true)
    await h.app.close()
  })

  test('the ASR worker takes the same lease with its own token', async () => {
    const h = await harness('ja')
    const asr = await h.app.inject({
      method: 'POST',
      url: '/worker/gpu/acquire',
      headers: { 'x-worker-token': ASR_TOKEN },
      payload: { owner: 'asr-worker', taskKind: 'asr' },
    })
    expect(asr.json().acquired).toBe(true)

    const translation = await h.app.inject({
      method: 'POST',
      url: '/worker/gpu/acquire',
      headers: worker(),
      payload: { owner: 'translation-worker', taskKind: 'translation' },
    })
    expect(translation.json().acquired).toBe(false)

    const released = await h.app.inject({
      method: 'POST',
      url: '/worker/gpu/release',
      headers: { 'x-worker-token': ASR_TOKEN },
      payload: { owner: 'asr-worker' },
    })
    expect(released.statusCode).toBe(204)
    await h.app.close()
  })
})
