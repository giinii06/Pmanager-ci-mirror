import { describe, expect, test } from 'bun:test'
import {
  acquireGpuLease,
  claimTranslationJob,
  completeAsrJob,
  completeTranslationJob,
  createAsrJob,
  createLibrary,
  createTranslationJob,
  failTranslationJob,
  getGpuLease,
  getTranslation,
  getTranslationJob,
  heartbeatGpuLease,
  heartbeatTranslationJob,
  insertAsset,
  isCurrentTranslation,
  openDatabase,
  recoverExpiredTranslationJobs,
  releaseGpuLease,
  updateTranslationProgress,
  upsertFolder,
} from './index'
import type { NewAsset } from './assets'

const MODEL = 'asr-rev-1'
const ALIGNER = 'aligner-rev-1'
const ASR_PIPELINE = 'asr-pipeline-1'
const SHA = 'sha-q4-k-m'
const PROMPT = 'prompt-1'
const TRANSLATION_PIPELINE = 'translation-1'

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
      resultDir: 'asset1/1/fp',
      plainText: 'それ、マジでやばくない？ 本当に？',
      language: 'ja',
      segments: [
        { seq: 0, startMs: 0, endMs: 2_000, text: 'それ、マジでやばくない？' },
        { seq: 1, startMs: 2_000, endMs: 4_000, text: '本当に？' },
      ],
    },
    2_000,
  )
  return db
}

function jobInput(overrides: Partial<Parameters<typeof createTranslationJob>[1]> = {}) {
  return {
    id: 'tr1',
    sourceTranscriptId: 'transcript1',
    assetId: 'asset1',
    fileVersion: 1,
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
    modelId: 'IndexTeam/Index-Translate-9B-GGUF',
    modelRevision: 'commit-sha',
    modelSha256: SHA,
    promptVersion: PROMPT,
    pipelineVersion: TRANSLATION_PIPELINE,
    ...overrides,
  }
}

function completeInput(overrides: Partial<Parameters<typeof completeTranslationJob>[1]> = {}) {
  return {
    jobId: 'tr1',
    owner: 'worker-a',
    translationId: 'translation1',
    resultDir: 'asset1/1/translations/transcript1/ko/fp',
    plainText: '저기, 진짜 심각하지 않아? 정말?',
    segments: [
      { seq: 0, startMs: 0, endMs: 2_000, text: '저기, 진짜 심각하지 않아?' },
      { seq: 1, startMs: 2_000, endMs: 4_000, text: '정말?' },
    ],
    ...overrides,
  }
}

describe('translation queue', () => {
  test('dedupes an active job for the same transcript and target', () => {
    const db = seed()
    const first = createTranslationJob(db, jobInput(), 3_000)
    const second = createTranslationJob(db, jobInput({ id: 'tr2' }), 3_100)

    expect(second.id).toBe(first.id)
    db.close()
  })

  test('a queued job from an older model is replaced, not joined', () => {
    const db = seed()
    const first = createTranslationJob(db, jobInput(), 3_000)
    const second = createTranslationJob(db, jobInput({ id: 'tr2', modelSha256: 'new-sha' }), 3_100)

    expect(second.id).toBe('tr2')
    expect(getTranslationJob(db, first.id)?.state).toBe('canceled')
    db.close()
  })

  test('a different target language gets its own job', () => {
    const db = seed()
    createTranslationJob(db, jobInput(), 3_000)
    const english = createTranslationJob(db, jobInput({ id: 'tr2', targetLanguage: 'en' }), 3_100)

    expect(english.id).toBe('tr2')
    db.close()
  })

  test('only one translation runs at a time', () => {
    const db = seed()
    createTranslationJob(db, jobInput(), 3_000)
    createTranslationJob(db, jobInput({ id: 'tr2', targetLanguage: 'en' }), 3_100)

    const first = claimTranslationJob(db, 'worker-a', 30_000, 3_200)
    const second = claimTranslationJob(db, 'worker-b', 30_000, 3_300)

    expect(first?.id).toBe('tr1')
    expect(second).toBeNull()
    db.close()
  })

  test('progress and heartbeat belong to the lease owner', () => {
    const db = seed()
    createTranslationJob(db, jobInput(), 3_000)
    claimTranslationJob(db, 'worker-a', 30_000, 3_100)

    expect(heartbeatTranslationJob(db, 'tr1', 'worker-b', 3_200)).toBe(false)
    expect(heartbeatTranslationJob(db, 'tr1', 'worker-a', 3_200)).toBe(true)
    expect(
      updateTranslationProgress(
        db,
        'tr1',
        'worker-b',
        { state: 'translating', stage: 'translating', progress: 40 },
        3_300,
      ),
    ).toBe(false)
    expect(
      updateTranslationProgress(
        db,
        'tr1',
        'worker-a',
        { state: 'translating', stage: 'translating', progress: 40 },
        3_300,
      ),
    ).toBe(true)
    db.close()
  })

  test('a renewal keeps the term the claim asked for', () => {
    const db = seed()
    createTranslationJob(db, jobInput(), 3_000)
    claimTranslationJob(db, 'worker-a', 600_000, 3_100)

    expect(heartbeatTranslationJob(db, 'tr1', 'worker-a', 4_000)).toBe(true)
    expect(getTranslationJob(db, 'tr1')?.leaseExpiresAt).toBe(604_000)

    expect(
      updateTranslationProgress(
        db,
        'tr1',
        'worker-a',
        { state: 'translating', stage: 'translating', progress: 40 },
        5_000,
      ),
    ).toBe(true)
    expect(getTranslationJob(db, 'tr1')?.leaseExpiresAt).toBe(605_000)
    db.close()
  })

  test('a renewal after the expiry is refused and leaves the lease dead', () => {
    const db = seed()
    createTranslationJob(db, jobInput(), 3_000)
    claimTranslationJob(db, 'worker-a', 600_000, 3_100)

    expect(heartbeatTranslationJob(db, 'tr1', 'worker-a', 603_101)).toBe(false)
    expect(getTranslationJob(db, 'tr1')?.leaseExpiresAt).toBe(603_100)
    db.close()
  })

  test('complete stores segments with the source timings', () => {
    const db = seed()
    createTranslationJob(db, jobInput(), 3_000)
    claimTranslationJob(db, 'worker-a', 30_000, 3_100)

    const stored = completeTranslationJob(db, completeInput(), 4_000)
    expect(stored?.id).toBe('translation1')

    const result = getTranslation(db, 'asset1', 1, 'ko')
    expect(result?.segments).toEqual([
      { seq: 0, startMs: 0, endMs: 2_000, text: '저기, 진짜 심각하지 않아?' },
      { seq: 1, startMs: 2_000, endMs: 4_000, text: '정말?' },
    ])
    expect(getTranslationJob(db, 'tr1')?.state).toBe('completed')
    db.close()
  })

  test('complete refuses a worker that lost the lease', () => {
    const db = seed()
    createTranslationJob(db, jobInput(), 3_000)
    claimTranslationJob(db, 'worker-a', 30_000, 3_100)

    expect(completeTranslationJob(db, completeInput({ owner: 'worker-b' }), 4_000)).toBeNull()
    expect(getTranslation(db, 'asset1', 1, 'ko')).toBeNull()
    db.close()
  })

  test('complete refuses when the source transcript was replaced', () => {
    const db = seed()
    createTranslationJob(db, jobInput(), 3_000)
    claimTranslationJob(db, 'worker-a', 30_000, 3_100)

    db.run("DELETE FROM transcripts WHERE id = 'transcript1'")

    expect(completeTranslationJob(db, completeInput(), 4_000)).toBeNull()
    expect(getTranslation(db, 'asset1', 1, 'ko')).toBeNull()
    db.close()
  })

  test('a completed translation does not block a new job', () => {
    const db = seed()
    createTranslationJob(db, jobInput(), 3_000)
    claimTranslationJob(db, 'worker-a', 30_000, 3_100)
    completeTranslationJob(db, completeInput(), 4_000)

    const next = createTranslationJob(db, jobInput({ id: 'tr2' }), 5_000)
    expect(next.id).toBe('tr2')
    db.close()
  })

  test('an expired lease returns to the queue', () => {
    const db = seed()
    createTranslationJob(db, jobInput(), 3_000)
    claimTranslationJob(db, 'worker-a', 10_000, 3_100)

    expect(recoverExpiredTranslationJobs(db, 20_000)).toBe(1)
    const recovered = getTranslationJob(db, 'tr1')
    expect(recovered?.state).toBe('queued')
    expect(recovered?.attempts).toBe(1)
    db.close()
  })

  test('failure backs off then ends at max attempts', () => {
    const db = seed()
    createTranslationJob(db, jobInput({ maxAttempts: 2 }), 3_000)
    claimTranslationJob(db, 'worker-a', 30_000, 3_100)

    expect(failTranslationJob(db, 'tr1', 'model output was invalid', 3_200)).toBe('queued')
    expect(getTranslationJob(db, 'tr1')?.runAfter).toBeGreaterThan(3_200)

    claimTranslationJob(db, 'worker-a', 30_000, 100_000)
    expect(failTranslationJob(db, 'tr1', 'model output was invalid', 100_100)).toBe('failed')
    db.close()
  })

  test('a stale fingerprint is not current', () => {
    const db = seed()
    createTranslationJob(db, jobInput(), 3_000)
    claimTranslationJob(db, 'worker-a', 30_000, 3_100)
    completeTranslationJob(db, completeInput(), 4_000)

    const stored = getTranslation(db, 'asset1', 1, 'ko')!
    expect(
      isCurrentTranslation(stored.translation, 'transcript1', {
        modelSha256: SHA,
        promptVersion: PROMPT,
        pipelineVersion: TRANSLATION_PIPELINE,
      }),
    ).toBe(true)
    expect(
      isCurrentTranslation(stored.translation, 'transcript1', {
        modelSha256: 'other-sha',
        promptVersion: PROMPT,
        pipelineVersion: TRANSLATION_PIPELINE,
      }),
    ).toBe(false)
    expect(
      isCurrentTranslation(stored.translation, 'transcript2', {
        modelSha256: SHA,
        promptVersion: PROMPT,
        pipelineVersion: TRANSLATION_PIPELINE,
      }),
    ).toBe(false)
    db.close()
  })
})

describe('gpu leases', () => {
  test('one owner holds the card and another is refused', () => {
    const db = openDatabase(':memory:')

    expect(
      acquireGpuLease(db, { resourceId: 'nvidia:0', owner: 'worker-a', taskKind: 'translation', leaseMs: 30_000 }, 1_000),
    ).toBe(true)
    expect(
      acquireGpuLease(db, { resourceId: 'nvidia:0', owner: 'worker-b', taskKind: 'asr', leaseMs: 30_000 }, 1_100),
    ).toBe(false)
    expect(getGpuLease(db, 'nvidia:0')?.owner).toBe('worker-a')
    db.close()
  })

  test('the same owner can renew and only that owner can release', () => {
    const db = openDatabase(':memory:')
    acquireGpuLease(db, { resourceId: 'mac:metal', owner: 'worker-a', taskKind: 'translation', leaseMs: 30_000 }, 1_000)

    expect(heartbeatGpuLease(db, 'mac:metal', 'worker-b', 1_100)).toBe(false)
    expect(heartbeatGpuLease(db, 'mac:metal', 'worker-a', 1_100)).toBe(true)
    expect(releaseGpuLease(db, 'mac:metal', 'worker-b', 1_100)).toBe(false)
    expect(releaseGpuLease(db, 'mac:metal', 'worker-a', 1_100)).toBe(true)
    expect(getGpuLease(db, 'mac:metal')).toBeNull()
    db.close()
  })

  test('a renewal keeps the term the lease was acquired with', () => {
    const db = openDatabase(':memory:')
    acquireGpuLease(
      db,
      { resourceId: 'nvidia:0', owner: 'worker-a', taskKind: 'embedding', leaseMs: 600_000 },
      1_000,
    )

    expect(heartbeatGpuLease(db, 'nvidia:0', 'worker-a', 40_000)).toBe(true)
    expect(getGpuLease(db, 'nvidia:0')?.leaseExpiresAt).toBe(640_000)
    db.close()
  })

  test('a renewal after the expiry is refused and leaves the lease dead', () => {
    const db = openDatabase(':memory:')
    acquireGpuLease(
      db,
      { resourceId: 'nvidia:0', owner: 'worker-a', taskKind: 'embedding', leaseMs: 600_000 },
      1_000,
    )

    expect(heartbeatGpuLease(db, 'nvidia:0', 'worker-a', 601_001)).toBe(false)
    expect(getGpuLease(db, 'nvidia:0')?.leaseExpiresAt).toBe(601_000)
    db.close()
  })

  test('an expired lease can be taken over', () => {
    const db = openDatabase(':memory:')
    acquireGpuLease(db, { resourceId: 'nvidia:0', owner: 'worker-a', taskKind: 'translation', leaseMs: 10_000 }, 1_000)

    expect(heartbeatGpuLease(db, 'nvidia:0', 'worker-a', 20_000)).toBe(false)
    expect(
      acquireGpuLease(db, { resourceId: 'nvidia:0', owner: 'worker-b', taskKind: 'asr', leaseMs: 10_000 }, 20_100),
    ).toBe(true)
    expect(getGpuLease(db, 'nvidia:0')?.owner).toBe('worker-b')
    db.close()
  })
})
