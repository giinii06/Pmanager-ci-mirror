import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  completeAsrJob,
  createAsrJob,
  createLibrary,
  finishScan,
  getPipelineCursor,
  insertAsset,
  openDatabase,
  setPipelineCursor,
  setScanState,
  upsertFolder,
  type Db,
  type NewAsset,
} from '@mediavault/database'
import { ensurePipelineJobs } from './index-trigger'
import type { ApiConfig } from './config'
import type { AppContext } from './context'
import { Semaphore } from './semaphore'

const ASR_TOKEN = 'asr-token-0000000000'
const TRANSLATION_TOKEN = 'translation-token-00000'
const EMBEDDING_TOKEN = 'embedding-token-000000'
const SCENE_TOKEN = 'scene-token-0000000000'
const SECRET = 'test-secret-for-session-signing'
const ASR_MODEL = 'asr-rev'
const ALIGNER = 'aligner-rev'
const ASR_PIPELINE = 'asr-1'
const NOW = 1_000_000

const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

function apiConfig(dir: string, options: { scene?: boolean }): ApiConfig {
  return {
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
      modelRevision: ASR_MODEL,
      alignerRevision: ALIGNER,
      pipelineVersion: ASR_PIPELINE,
      retryMs: 15 * 60_000,
    },
    translation: {
      enabled: true,
      workerToken: TRANSLATION_TOKEN,
      resultDir: dir,
      modelId: 'translate-model',
      modelRevision: 'commit-sha',
      modelSha256: 'sha-tr',
      promptVersion: '1',
      pipelineVersion: 'tr-1',
      targetLanguage: 'ko',
    },
    embedding: {
      enabled: true,
      workerToken: EMBEDDING_TOKEN,
      modelId: 'embedding-model',
      modelRevision: 'commit-sha',
      modelSha256: 'sha-emb',
      pipelineVersion: 'emb-1',
      dimensions: 4,
    },
    scene: {
      enabled: options.scene ?? false,
      workerToken: options.scene ? SCENE_TOKEN : '',
      modelId: 'facebook/pe-av-base-16-frame',
      modelRevision: 'commit-sha',
      modelSha256: 'sha-scene',
      pipelineVersion: 'scene-1',
      dimensions: 4,
      windowMs: 10_000,
      overlapMs: 2_000,
      maxWindows: 120,
      queryUrl: 'http://127.0.0.1:1',
    },
  }
}

interface Harness {
  db: Db
  ctx: AppContext
  addVideo: (id: string, audioCodec: string | null) => void
  scannedAt: (at: number) => void
}

async function harness(options: { scene?: boolean } = {}): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mediavault-pass-'))
  dirs.push(dir)
  const db = openDatabase(':memory:')

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

  const ctx: AppContext = {
    config: apiConfig(dir, options),
    db,
    thumbnails: new Semaphore(1),
    previews: new Semaphore(1),
  }

  return {
    db,
    ctx,
    addVideo(id: string, audioCodec: string | null) {
      const asset: NewAsset = {
        id,
        libraryId: 'lib1',
        folderId,
        relativePath: `Videos/${id}.mp4`,
        filename: `${id}.mp4`,
        kind: 'video',
        mimeType: 'video/mp4',
        sizeBytes: 1_000,
        mtimeMs: 1_000,
        width: 640,
        height: 360,
        durationMs: 60_000,
        takenAt: 10_000,
        videoCodec: 'h264',
        audioCodec,
        container: 'mp4',
        indexedAt: 20_000,
        scanId: 'scan1',
      }
      insertAsset(db, asset)
    },
    scannedAt(at: number) {
      finishScan(db, 'lib1', at, 1)
    },
  }
}

function storeTranscript(h: Harness, assetId: string, language: string): string {
  const job = createAsrJob(
    h.db,
    {
      id: `asr-${assetId}`,
      assetId,
      fileVersion: 1,
      modelRevision: ASR_MODEL,
      alignerRevision: ALIGNER,
      pipelineVersion: ASR_PIPELINE,
    },
    NOW - 10,
  )
  const transcript = completeAsrJob(
    h.db,
    {
      jobId: job.id,
      transcriptId: `tr-${assetId}`,
      resultDir: `asr/${assetId}`,
      plainText: 'hello',
      language,
      segments: [{ seq: 0, startMs: 0, endMs: 1_000, text: 'hello' }],
    },
    NOW - 5,
  )
  return transcript!.id
}

function jobCount(h: Harness, table: string, assetId?: string): number {
  const row = assetId
    ? h.db
        .query<{ n: number }, string>(`SELECT COUNT(*) AS n FROM ${table} WHERE asset_id = ?`)
        .get(assetId)
    : h.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()
  return row?.n ?? 0
}

describe('pipeline pass', () => {
  test('a video with audio and no transcript gets an ASR job, once', async () => {
    const h = await harness()
    h.scannedAt(NOW - 60_000)
    h.addVideo('video1', 'aac')

    const first = ensurePipelineJobs(h.ctx, NOW)
    expect(first.asr).toBe(1)
    expect(jobCount(h, 'asr_jobs', 'video1')).toBe(1)

    const second = ensurePipelineJobs(h.ctx, NOW + 1_000)
    expect(second.asr).toBe(0)
    expect(jobCount(h, 'asr_jobs', 'video1')).toBe(1)
  })

  test('a video with no audio stream is never transcribed but is still embedded', async () => {
    const h = await harness()
    h.scannedAt(NOW - 60_000)
    h.addVideo('silent', null)

    const result = ensurePipelineJobs(h.ctx, NOW)

    expect(result.asr).toBe(0)
    expect(jobCount(h, 'asr_jobs', 'silent')).toBe(0)
    expect(result.embeddings).toBe(1)
    expect(result.translations).toBe(0)

    const embedding = h.db
      .query<{ sourceTranscriptId: string | null }, string>(
        'SELECT source_transcript_id AS sourceTranscriptId FROM embedding_jobs WHERE asset_id = ?',
      )
      .get('silent')
    expect(embedding?.sourceTranscriptId).toBeNull()

    const second = ensurePipelineJobs(h.ctx, NOW + 1_000)
    expect(second.embeddings).toBe(0)
  })

  test('a current transcript gets no ASR job but does get a translation and an embedding', async () => {
    const h = await harness()
    h.scannedAt(NOW - 60_000)
    h.addVideo('video1', 'aac')
    storeTranscript(h, 'video1', 'en')

    const first = ensurePipelineJobs(h.ctx, NOW)
    expect(first.asr).toBe(0)
    expect(first.translations).toBe(1)
    expect(first.embeddings).toBe(1)

    const second = ensurePipelineJobs(h.ctx, NOW + 1_000)
    expect(second.asr).toBe(0)
    expect(second.translations).toBe(0)
    expect(second.embeddings).toBe(0)
  })

  test('a source that already speaks the target is not translated', async () => {
    const h = await harness()
    h.scannedAt(NOW - 60_000)
    h.addVideo('video1', 'aac')
    storeTranscript(h, 'video1', 'ko')

    const result = ensurePipelineJobs(h.ctx, NOW)

    expect(result.translations).toBe(0)
    expect(jobCount(h, 'translation_jobs')).toBe(0)
    expect(result.embeddings).toBe(1)
  })

  test('a fresh ASR failure waits for the retry cooldown', async () => {
    const h = await harness()
    h.scannedAt(NOW - 60_000)
    h.addVideo('video1', 'aac')
    const job = createAsrJob(
      h.db,
      {
        id: 'asr-failed',
        assetId: 'video1',
        fileVersion: 1,
        modelRevision: ASR_MODEL,
        alignerRevision: ALIGNER,
        pipelineVersion: ASR_PIPELINE,
      },
      NOW - 100,
    )
    h.db
      .query(`UPDATE asr_jobs SET state = 'failed', attempts = max_attempts, updated_at = ? WHERE id = ?`)
      .run(NOW - 50, job.id)

    const result = ensurePipelineJobs(h.ctx, NOW)

    expect(result.asr).toBe(0)
    expect(jobCount(h, 'asr_jobs', 'video1')).toBe(1)
    expect(h.db.query<{ state: string }, []>('SELECT state FROM asr_jobs').get()?.state).toBe(
      'failed',
    )
  })

  test('an ASR failure older than the cooldown is queued again', async () => {
    const h = await harness()
    h.scannedAt(NOW - 60_000)
    h.addVideo('video1', 'aac')
    const job = createAsrJob(
      h.db,
      {
        id: 'asr-failed',
        assetId: 'video1',
        fileVersion: 1,
        modelRevision: ASR_MODEL,
        alignerRevision: ALIGNER,
        pipelineVersion: ASR_PIPELINE,
      },
      NOW - 20 * 60_000,
    )
    h.db
      .query(`UPDATE asr_jobs SET state = 'failed', attempts = max_attempts, updated_at = ? WHERE id = ?`)
      .run(NOW - 16 * 60_000, job.id)

    const result = ensurePipelineJobs(h.ctx, NOW)

    expect(result.asr).toBe(1)
    expect(jobCount(h, 'asr_jobs', 'video1')).toBe(1)
    const row = h.db
      .query<{ state: string; attempts: number }, []>('SELECT state, attempts FROM asr_jobs')
      .get()
    expect(row?.state).toBe('queued')
    expect(row?.attempts).toBe(0)
  })

  test('a terminal failure from an older pipeline is retried at once', async () => {
    const h = await harness()
    h.scannedAt(NOW - 60_000)
    h.addVideo('video1', 'aac')
    const job = createAsrJob(
      h.db,
      {
        id: 'asr-old',
        assetId: 'video1',
        fileVersion: 1,
        modelRevision: ASR_MODEL,
        alignerRevision: ALIGNER,
        pipelineVersion: 'asr-0',
      },
      NOW - 100,
    )
    h.db
      .query(`UPDATE asr_jobs SET state = 'failed', attempts = max_attempts, updated_at = ? WHERE id = ?`)
      .run(NOW - 50, job.id)

    const result = ensurePipelineJobs(h.ctx, NOW)

    expect(result.asr).toBe(1)
    expect(jobCount(h, 'asr_jobs', 'video1')).toBe(1)
    const row = h.db
      .query<{ state: string; pipelineVersion: string }, []>(
        'SELECT state, pipeline_version AS pipelineVersion FROM asr_jobs',
      )
      .get()
    expect(row?.state).toBe('queued')
    expect(row?.pipelineVersion).toBe(ASR_PIPELINE)
  })

  test('an active ASR job is not duplicated', async () => {
    const h = await harness()
    h.scannedAt(NOW - 60_000)
    h.addVideo('video1', 'aac')
    createAsrJob(
      h.db,
      {
        id: 'asr-active',
        assetId: 'video1',
        fileVersion: 1,
        modelRevision: ASR_MODEL,
        alignerRevision: ALIGNER,
        pipelineVersion: ASR_PIPELINE,
      },
      NOW - 100,
    )

    const result = ensurePipelineJobs(h.ctx, NOW)

    expect(result.asr).toBe(0)
    expect(jobCount(h, 'asr_jobs', 'video1')).toBe(1)
  })

  test('a library that has never been scanned is queued once', async () => {
    const h = await harness()

    const first = ensurePipelineJobs(h.ctx, NOW)
    expect(first.scanned).toBe(1)

    const library = h.db
      .query<{ scanState: string }, []>('SELECT scan_state AS scanState FROM libraries')
      .get()
    expect(library?.scanState).toBe('queued')
    expect(jobCount(h, 'jobs')).toBe(1)

    const second = ensurePipelineJobs(h.ctx, NOW + 1_000)
    expect(second.scanned).toBe(0)
    expect(jobCount(h, 'jobs')).toBe(1)
  })

  test('a library scanned inside the interval is left alone', async () => {
    const h = await harness()
    h.scannedAt(NOW - 60_000)

    const result = ensurePipelineJobs(h.ctx, NOW)

    expect(result.scanned).toBe(0)
    expect(jobCount(h, 'jobs')).toBe(0)
  })

  test('a scan state left without a job is repaired on the next pass', async () => {
    const h = await harness()
    h.scannedAt(NOW - 1_000)
    // The crash window: the state was written, the job was not.
    setScanState(h.db, 'lib1', 'queued')

    const first = ensurePipelineJobs(h.ctx, NOW)
    expect(first.scanned).toBe(1)
    expect(jobCount(h, 'jobs')).toBe(1)

    const second = ensurePipelineJobs(h.ctx, NOW + 1_000)
    expect(second.scanned).toBe(0)
    expect(jobCount(h, 'jobs')).toBe(1)
  })

  test('scene jobs still queue for a new video', async () => {
    const h = await harness({ scene: true })
    h.scannedAt(NOW - 60_000)
    h.addVideo('video1', 'aac')

    const result = ensurePipelineJobs(h.ctx, NOW)

    expect(result.scenes).toBe(1)
    expect(result.asr).toBe(1)
  })
})

describe('index cursor', () => {
  test('the cursor covers every video across passes', async () => {
    const h = await harness()
    h.scannedAt(NOW - 60_000)
    const ids = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7']
    for (const id of ids) h.addVideo(id, 'aac')

    for (let pass = 0; pass < 4; pass += 1) {
      const result = ensurePipelineJobs(h.ctx, NOW + pass * 1_000, 3)
      expect(result.considered).toBe(3)
    }

    const considered = h.db
      .query<{ assetId: string }, []>('SELECT DISTINCT asset_id AS assetId FROM asr_jobs')
      .all()
      .map((row) => row.assetId)
    expect(new Set(considered)).toEqual(new Set(ids))
  })

  test('a second pass continues from the stored cursor', async () => {
    const h = await harness()
    h.scannedAt(NOW - 60_000)
    for (const id of ['v1', 'v2', 'v3', 'v4', 'v5', 'v6']) h.addVideo(id, 'aac')

    ensurePipelineJobs(h.ctx, NOW, 3)
    expect(getPipelineCursor(h.db, 'index')?.lastId).toBe('v3')

    const restarted: AppContext = { ...h.ctx }
    ensurePipelineJobs(restarted, NOW + 1_000, 3)

    expect(getPipelineCursor(h.db, 'index')?.lastId).toBe('v6')
  })

  test('the cursor wraps to the lowest id after the last one', async () => {
    const h = await harness()
    h.scannedAt(NOW - 60_000)
    for (const id of ['v1', 'v2', 'v3', 'v4']) h.addVideo(id, 'aac')
    setPipelineCursor(h.db, 'index', 'v4', NOW - 1_000)

    const result = ensurePipelineJobs(h.ctx, NOW, 3)

    expect(result.considered).toBe(3)
    expect(getPipelineCursor(h.db, 'index')?.lastId).toBe('v3')
    const queued = h.db
      .query<{ assetId: string }, []>('SELECT asset_id AS assetId FROM asr_jobs ORDER BY asset_id')
      .all()
      .map((row) => row.assetId)
    expect(queued).toEqual(['v1', 'v2', 'v3'])
  })

  test('a pass that throws leaves the cursor unchanged', async () => {
    const h = await harness()
    h.scannedAt(NOW - 60_000)
    h.addVideo('v1', 'aac')
    h.db.exec(
      "CREATE TRIGGER fail_asr BEFORE INSERT ON asr_jobs BEGIN SELECT RAISE(ABORT, 'boom'); END",
    )

    expect(() => ensurePipelineJobs(h.ctx, NOW, 3)).toThrow('boom')

    expect(getPipelineCursor(h.db, 'index')).toBeNull()
  })

  test('an empty library leaves the cursor empty', async () => {
    const h = await harness()
    h.scannedAt(NOW - 60_000)

    ensurePipelineJobs(h.ctx, NOW, 3)

    expect(getPipelineCursor(h.db, 'index')).toBeNull()
  })

  test('a library smaller than the batch is considered once', async () => {
    const h = await harness()
    h.scannedAt(NOW - 60_000)
    h.addVideo('v1', 'aac')
    h.addVideo('v2', 'aac')

    const result = ensurePipelineJobs(h.ctx, NOW, 5)

    expect(result.considered).toBe(2)
    expect(getPipelineCursor(h.db, 'index')?.lastId).toBe('v2')
  })
})
