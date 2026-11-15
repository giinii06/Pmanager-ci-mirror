import { describe, expect, test } from 'bun:test'
import {
  cancelAsrJob,
  claimAsrJob,
  completeAsrJob,
  createAsrJob,
  createLibrary,
  failAsrJob,
  getTranscript,
  insertAsset,
  latestAsrJob,
  openDatabase,
  recoverExpiredAsrJobs,
  searchTranscript,
  updateAsrProgress,
  upsertFolder,
} from './index'
import type { NewAsset } from './assets'

const MODEL = 'asr-rev-1'
const ALIGNER = 'aligner-rev-1'
const PIPELINE = 'pipeline-1'

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

function seed() {
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
  insertAsset(db, assetInput('asset1', folderId))
  return db
}

function jobInput(overrides: Partial<Parameters<typeof createAsrJob>[1]> = {}) {
  return {
    id: 'job1',
    assetId: 'asset1',
    fileVersion: 1,
    modelRevision: MODEL,
    alignerRevision: ALIGNER,
    pipelineVersion: PIPELINE,
    ...overrides,
  }
}

describe('asr queue', () => {
  test('dedupes an active job for the same asset version', () => {
    const db = seed()
    const first = createAsrJob(db, jobInput(), 1_000)
    const second = createAsrJob(db, jobInput({ id: 'job2' }), 1_100)

    expect(second.id).toBe(first.id)
    db.close()
  })

  test('a new file version gets its own job', () => {
    const db = seed()
    createAsrJob(db, jobInput(), 1_000)
    const other = createAsrJob(db, jobInput({ id: 'job2', fileVersion: 2 }), 1_100)
    expect(other.id).toBe('job2')
    db.close()
  })

  test('claim leases the job and reports progress under the lease owner', () => {
    const db = seed()
    createAsrJob(db, jobInput(), 1_000)

    const claimed = claimAsrJob(db, 'worker-a', 30_000, 1_100)
    expect(claimed?.id).toBe('job1')
    expect(claimed?.attempts).toBe(1)
    expect(claimed?.stage).toBe('extracting')

    expect(
      updateAsrProgress(
        db,
        'job1',
        'worker-b',
        { state: 'transcribing', stage: 'transcribing', progress: 40, leaseMs: 30_000 },
        1_200,
      ),
    ).toBe(false)
    expect(
      updateAsrProgress(
        db,
        'job1',
        'worker-a',
        { state: 'transcribing', stage: 'transcribing', progress: 40, leaseMs: 30_000 },
        1_200,
      ),
    ).toBe(true)
    expect(claimAsrJob(db, 'worker-b', 30_000, 1_300)).toBeNull()
    db.close()
  })

  test('only one job runs at a time across assets', () => {
    const db = seed()
    insertAsset(db, assetInput('asset2', 'folder1'))
    createAsrJob(db, jobInput(), 1_000)
    createAsrJob(db, jobInput({ id: 'job2', assetId: 'asset2' }), 1_050)

    expect(claimAsrJob(db, 'worker-a', 30_000, 1_100)?.id).toBe('job1')
    expect(claimAsrJob(db, 'worker-b', 30_000, 1_200)).toBeNull()

    completeAsrJob(
      db,
      {
        jobId: 'job1',
        transcriptId: 'tr1',
        resultDir: 'asset1/1/key',
        plainText: 'first',
        language: 'ko',
        segments: [],
      },
      1_300,
    )

    expect(claimAsrJob(db, 'worker-b', 30_000, 1_400)?.id).toBe('job2')
    db.close()
  })

  test('an expired lease returns the job to the queue', () => {
    const db = seed()
    createAsrJob(db, jobInput(), 1_000)
    claimAsrJob(db, 'worker-a', 1_000, 1_100)

    expect(recoverExpiredAsrJobs(db, 2_200)).toBe(1)
    const claimed = claimAsrJob(db, 'worker-b', 1_000, 2_300)
    expect(claimed?.attempts).toBe(2)
    db.close()
  })

  test('retries with backoff and gives up at max attempts', () => {
    const db = seed()
    createAsrJob(db, jobInput({ maxAttempts: 2 }), 1_000)
    claimAsrJob(db, 'worker-a', 30_000, 1_100)
    expect(failAsrJob(db, 'job1', 'ffmpeg failed', 1_200)).toBe('queued')
    expect(claimAsrJob(db, 'worker-a', 30_000, 2_000)).toBeNull()

    claimAsrJob(db, 'worker-a', 30_000, 7_000)
    expect(failAsrJob(db, 'job1', 'ffmpeg failed again', 7_100)).toBe('failed')
    expect(latestAsrJob(db, 'asset1', 1)?.errorMessage).toBe('ffmpeg failed again')
    db.close()
  })

  test('a canceled job cannot be claimed', () => {
    const db = seed()
    createAsrJob(db, jobInput(), 1_000)
    cancelAsrJob(db, 'job1', 1_100)
    expect(claimAsrJob(db, 'worker-a', 30_000, 1_200)).toBeNull()
    expect(latestAsrJob(db, 'asset1', 1)?.state).toBe('canceled')
    db.close()
  })
})

describe('transcripts', () => {
  test('completion stores segments and replaces the same model identity', () => {
    const db = seed()
    createAsrJob(db, jobInput(), 1_000)
    claimAsrJob(db, 'worker-a', 30_000, 1_100)

    completeAsrJob(
      db,
      {
        jobId: 'job1',
        transcriptId: 'tr1',
        resultDir: 'asset1/1/asr-rev-1_aligner-rev-1_pipeline-1',
        plainText: '안녕하세요',
        language: 'ko',
        segments: [{ seq: 0, startMs: 0, endMs: 900, text: '안녕하세요' }],
      },
      1_500,
    )

    const stored = getTranscript(db, 'asset1', 1)
    expect(stored?.segments).toHaveLength(1)
    expect(stored?.transcript.plainText).toBe('안녕하세요')
    expect(searchTranscript(db, 'tr1', '안녕')).toHaveLength(1)
    expect(searchTranscript(db, 'tr1', '없음')).toHaveLength(0)

    const second = createAsrJob(db, jobInput({ id: 'job2' }), 2_000)
    expect(second.id).toBe('job2')
    claimAsrJob(db, 'worker-a', 30_000, 2_100)
    completeAsrJob(
      db,
      {
        jobId: 'job2',
        transcriptId: 'tr2',
        resultDir: 'asset1/1/asr-rev-1_aligner-rev-1_pipeline-1',
        plainText: '다시',
        language: 'ko',
        segments: [{ seq: 0, startMs: 0, endMs: 400, text: '다시' }],
      },
      2_500,
    )

    expect(getTranscript(db, 'asset1', 1)?.transcript.id).toBe('tr2')
    expect(
      db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM transcripts').get()?.n,
    ).toBe(1)
    db.close()
  })

  test('a stale file version keeps its own transcript', () => {
    const db = seed()
    createAsrJob(db, jobInput(), 1_000)
    claimAsrJob(db, 'worker-a', 30_000, 1_100)
    completeAsrJob(
      db,
      {
        jobId: 'job1',
        transcriptId: 'tr1',
        resultDir: 'asset1/1/key',
        plainText: 'v1',
        language: 'ko',
        segments: [],
      },
      1_500,
    )

    expect(getTranscript(db, 'asset1', 1)?.transcript.id).toBe('tr1')
    expect(getTranscript(db, 'asset1', 2)).toBeNull()
    db.close()
  })
})
