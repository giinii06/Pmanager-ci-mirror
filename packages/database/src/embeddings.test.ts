import { describe, expect, test } from 'bun:test'
import {
  claimEmbeddingJob,
  completeAsrJob,
  completeEmbeddingJob,
  createAsrJob,
  createEmbeddingJob,
  createLibrary,
  getCurrentEmbedding,
  getEmbeddingJob,
  insertAsset,
  openDatabase,
  recoverExpiredEmbeddingJobs,
  relatedByEmbedding,
  updateEmbeddingProgress,
  upsertFolder,
} from './index'
import type { CompleteEmbeddingJobInput, EmbeddingVectorInput } from './embeddings'
import type { NewAsset } from './assets'
import type { Db } from './db'

const DIMENSIONS = 4
const SHA = 'sha-embed-1'
const PIPELINE = 'embed-pipeline-1'
const MODEL = 'asr-rev-1'
const ALIGNER = 'aligner-rev-1'
const ASR_PIPELINE = 'asr-pipeline-1'

const FINGERPRINT = { modelSha256: SHA, pipelineVersion: PIPELINE, dimensions: DIMENSIONS }

const ASSETS = ['asset1', 'asset2', 'asset3', 'asset4']

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

function transcript(db: Db, assetId: string): string {
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
      plainText: `${assetId} transcript`,
      language: 'ko',
      segments: [{ seq: 0, startMs: 0, endMs: 2_000, text: `${assetId} transcript` }],
    },
    2_000,
  )
  return `tr-${assetId}`
}

/** Stores a newer transcript for the same file version, as a re-run would. */
function retranscribe(db: Db, assetId: string, tag: string, at = 6_000): string {
  createAsrJob(
    db,
    {
      id: `asr-${assetId}-${tag}`,
      assetId,
      fileVersion: 1,
      modelRevision: MODEL,
      alignerRevision: ALIGNER,
      pipelineVersion: `asr-pipeline-${tag}`,
    },
    at,
  )
  completeAsrJob(
    db,
    {
      jobId: `asr-${assetId}-${tag}`,
      transcriptId: `tr-${assetId}-${tag}`,
      resultDir: `${assetId}/1/source-${tag}`,
      plainText: `${assetId} ${tag}`,
      language: 'ko',
      segments: [{ seq: 0, startMs: 0, endMs: 2_000, text: `${assetId} ${tag}` }],
    },
    at + 100,
  )
  return `tr-${assetId}-${tag}`
}

function seed(): Db {
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
  for (const id of ASSETS) insertAsset(db, assetInput(id, folderId))
  // A re-upload of asset1 under another path: same filename, same size.
  insertAsset(db, {
    ...assetInput('asset1-copy', folderId),
    relativePath: 'Videos/copy-of-asset1.mp4',
    filename: 'asset1.mp4',
  })
  for (const id of [...ASSETS, 'asset1-copy']) transcript(db, id)
  return db
}

function jobInput(overrides: Partial<Parameters<typeof createEmbeddingJob>[1]> = {}) {
  return {
    id: 'embed1',
    assetId: 'asset1',
    fileVersion: 1,
    sourceTranscriptId: 'tr-asset1',
    modelId: 'Qwen/Qwen3-Embedding-4B-GGUF',
    modelRevision: 'commit-sha',
    modelSha256: SHA,
    pipelineVersion: PIPELINE,
    dimensions: DIMENSIONS,
    ...overrides,
  }
}

function chunk(index: number, vector: number[]): EmbeddingVectorInput {
  return {
    kind: 'chunk',
    chunkIndex: index,
    startMs: index * 2_000,
    endMs: index * 2_000 + 2_000,
    text: `chunk ${index}`,
    vector: Float32Array.from(vector),
  }
}

/** Enqueues, claims, and completes one pass, so the vectors land as a worker's would. */
function store(
  db: Db,
  assetId: string,
  vectors: EmbeddingVectorInput[],
  at = 5_000,
): void {
  const job = createEmbeddingJob(
    db,
    jobInput({ id: `embed-${assetId}-${at}`, assetId, sourceTranscriptId: `tr-${assetId}` }),
    at,
  )
  claimEmbeddingJob(db, 'worker-a', 120_000, at + 1)
  const stored = completeEmbeddingJob(
    db,
    { jobId: job.id, owner: 'worker-a', vectors },
    at + 2,
  )
  expect(stored).toBe(true)
}

describe('embedding queue', () => {
  test('an unchanged re-enqueue keeps the row as it stands', () => {
    const db = seed()
    const first = createEmbeddingJob(db, jobInput(), 3_000)
    claimEmbeddingJob(db, 'worker-a', 120_000, 3_100)
    updateEmbeddingProgress(
      db,
      first.id,
      'worker-a',
      { state: 'embedding', stage: 'embedding', progress: 40, leaseMs: 120_000 },
      3_200,
    )

    const again = createEmbeddingJob(db, jobInput({ id: 'embed2' }), 3_300)

    expect(again.id).toBe(first.id)
    expect(again.state).toBe('embedding')
    expect(again.progress).toBe(40)
    expect(again.attempts).toBe(1)
    db.close()
  })

  test('a new model fingerprint rebuilds the row from queued', () => {
    const db = seed()
    const first = createEmbeddingJob(db, jobInput(), 3_000)
    claimEmbeddingJob(db, 'worker-a', 120_000, 3_100)
    updateEmbeddingProgress(
      db,
      first.id,
      'worker-a',
      { state: 'embedding', stage: 'embedding', progress: 40, leaseMs: 120_000 },
      3_200,
    )

    const rebuilt = createEmbeddingJob(db, jobInput({ modelSha256: 'sha-embed-2' }), 3_300)

    expect(rebuilt.id).toBe(first.id)
    expect(rebuilt.state).toBe('queued')
    expect(rebuilt.stage).toBe('queued')
    expect(rebuilt.progress).toBe(0)
    expect(rebuilt.attempts).toBe(0)
    expect(rebuilt.leaseOwner).toBeNull()
    expect(rebuilt.leaseExpiresAt).toBeNull()
    expect(rebuilt.modelSha256).toBe('sha-embed-2')
    expect(rebuilt.updatedAt).toBe(3_300)
    db.close()
  })

  test('a replaced transcript rebuilds the row even on the same model', () => {
    const db = seed()
    createEmbeddingJob(db, jobInput(), 3_000)
    claimEmbeddingJob(db, 'worker-a', 120_000, 3_100)
    const replaced = retranscribe(db, 'asset1', 'v2', 3_200)

    const rebuilt = createEmbeddingJob(
      db,
      jobInput({ id: 'embed2', sourceTranscriptId: replaced }),
      3_300,
    )

    expect(rebuilt.state).toBe('queued')
    expect(rebuilt.sourceTranscriptId).toBe(replaced)
    db.close()
  })

  test('a live lease keeps the second job queued', () => {
    const db = seed()
    createEmbeddingJob(db, jobInput(), 3_000)
    createEmbeddingJob(
      db,
      jobInput({ id: 'embed2', assetId: 'asset2', sourceTranscriptId: 'tr-asset2' }),
      3_001,
    )

    const first = claimEmbeddingJob(db, 'worker-a', 120_000, 3_100)
    expect(first?.assetId).toBe('asset1')
    expect(first?.stage).toBe('starting')
    expect(first?.attempts).toBe(1)
    expect(claimEmbeddingJob(db, 'worker-b', 120_000, 3_200)).toBeNull()

    completeEmbeddingJob(
      db,
      { jobId: first!.id, owner: 'worker-a', vectors: [chunk(0, [1, 0, 0, 0])] },
      3_300,
    )
    const second = claimEmbeddingJob(db, 'worker-b', 120_000, 3_400)
    expect(second?.assetId).toBe('asset2')
    db.close()
  })

  test('an expired lease returns the job to the queue with the attempt counted', () => {
    const db = seed()
    const job = createEmbeddingJob(db, jobInput(), 3_000)
    claimEmbeddingJob(db, 'worker-a', 120_000, 3_100)

    expect(recoverExpiredEmbeddingJobs(db, 3_100 + 120_001)).toBe(1)

    const recovered = getEmbeddingJob(db, job.id)
    expect(recovered?.state).toBe('queued')
    expect(recovered?.stage).toBe('queued')
    expect(recovered?.attempts).toBe(1)
    expect(recovered?.leaseOwner).toBeNull()
    expect(recovered?.errorMessage).toBe('The worker stopped before finishing.')
    db.close()
  })

  test('complete refuses a worker that no longer owns the lease', () => {
    const db = seed()
    const job = createEmbeddingJob(db, jobInput(), 3_000)
    claimEmbeddingJob(db, 'worker-a', 120_000, 3_100)

    const stored = completeEmbeddingJob(
      db,
      { jobId: job.id, owner: 'worker-b', vectors: [chunk(0, [1, 0, 0, 0])] },
      3_200,
    )

    expect(stored).toBe(false)
    expect(getEmbeddingJob(db, job.id)?.state).toBe('embedding')
    expect(getCurrentEmbedding(db, 'asset1', 1, FINGERPRINT)).toHaveLength(0)
    db.close()
  })

  test('a second pass replaces every vector for the file version', () => {
    const db = seed()
    store(db, 'asset1', [chunk(0, [1, 0, 0, 0]), chunk(1, [0, 1, 0, 0])], 5_000)
    expect(getCurrentEmbedding(db, 'asset1', 1, FINGERPRINT)).toHaveLength(2)

    store(db, 'asset1', [chunk(0, [0, 0, 1, 0])], 6_000)

    const stored = getCurrentEmbedding(db, 'asset1', 1, FINGERPRINT)
    expect(stored).toHaveLength(1)
    expect(stored[0]!.chunkIndex).toBe(0)
    expect([...stored[0]!.vector]).toEqual([0, 0, 1, 0])
    db.close()
  })

  test('a vector of the wrong length is refused before anything is written', () => {
    const db = seed()
    const job = createEmbeddingJob(db, jobInput(), 3_000)
    claimEmbeddingJob(db, 'worker-a', 120_000, 3_100)

    expect(() =>
      completeEmbeddingJob(
        db,
        { jobId: job.id, owner: 'worker-a', vectors: [chunk(0, [1, 0, 0])] },
        3_200,
      ),
    ).toThrow('3 dimensions, expected 4')

    expect(getCurrentEmbedding(db, 'asset1', 1, FINGERPRINT)).toHaveLength(0)
    expect(getEmbeddingJob(db, job.id)?.state).toBe('embedding')
    db.close()
  })

  test('a vector that is not unit length is refused', () => {
    const db = seed()
    const job = createEmbeddingJob(db, jobInput(), 3_000)
    claimEmbeddingJob(db, 'worker-a', 120_000, 3_100)

    expect(() =>
      completeEmbeddingJob(
        db,
        { jobId: job.id, owner: 'worker-a', vectors: [chunk(0, [2, 0, 0, 0])] },
        3_200,
      ),
    ).toThrow('norm is 2.0000')
    db.close()
  })
})

describe('related by embedding', () => {
  function ranked(db: Db, limit = 8): string[] {
    return relatedByEmbedding(db, 'user1', 'asset1', 1, FINGERPRINT, limit).map(
      (asset) => asset.id,
    )
  }

  test('orders the other videos by the closest vector pair', () => {
    const db = seed()
    store(db, 'asset1', [chunk(0, [1, 0, 0, 0])], 5_000)
    store(db, 'asset2', [chunk(0, [0, 1, 0, 0]), chunk(1, [1, 0, 0, 0])], 5_100)
    store(db, 'asset3', [chunk(0, [0, 0, 1, 0])], 5_200)
    store(db, 'asset4', [chunk(0, [0.6, 0.8, 0, 0])], 5_300)

    expect(ranked(db)).toEqual(['asset2', 'asset4', 'asset3'])
    db.close()
  })

  test('drops a re-upload of the same file and honours the limit', () => {
    const db = seed()
    store(db, 'asset1', [chunk(0, [1, 0, 0, 0])], 5_000)
    store(db, 'asset1-copy', [chunk(0, [1, 0, 0, 0])], 5_100)
    store(db, 'asset2', [chunk(0, [0.6, 0.8, 0, 0])], 5_200)
    store(db, 'asset3', [chunk(0, [0, 0, 1, 0])], 5_300)

    expect(ranked(db)).toEqual(['asset2', 'asset3'])
    expect(ranked(db, 1)).toEqual(['asset2'])
    db.close()
  })

  test('a vector built from a replaced transcript does not rank', () => {
    const db = seed()
    store(db, 'asset1', [chunk(0, [1, 0, 0, 0])], 5_000)
    store(db, 'asset2', [chunk(0, [1, 0, 0, 0])], 5_100)
    expect(ranked(db)).toEqual(['asset2'])

    retranscribe(db, 'asset2', 'v2')

    expect(ranked(db)).toEqual([])
    db.close()
  })
})
