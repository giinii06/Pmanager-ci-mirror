import { describe, expect, test } from 'bun:test'
import { formatJobError } from '@mediavault/shared'
import {
  acquireGpuLease,
  claimAsrJob,
  claimEmbeddingJob,
  claimNextJob,
  claimSceneJob,
  completeEmbeddingJob,
  completeJob,
  createAsrJob,
  createEmbeddingJob,
  createLibrary,
  createSceneJob,
  deleteLibrary,
  enqueueJob,
  failAsrJob,
  failEmbeddingJob,
  failJob,
  failSceneJob,
  insertAsset,
  openDatabase,
  sceneWindowCount,
  upsertFolder,
  workQueue,
} from './index'
import type { NewAsset } from './assets'
import type { Db } from './db'

const RESOURCE = 'gpu:0'
const MODEL = 'asr-rev-1'
const ALIGNER = 'aligner-rev-1'
const PIPELINE = 'asr-pipeline-1'

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
  insertAsset(db, assetInput('asset2', folderId))
  insertAsset(db, assetInput('asset3', folderId))
  return db
}

function finishedMedia(
  db: ReturnType<typeof seed>,
  key: string,
  start: number,
  durationMs: number,
): number {
  enqueueJob(db, { dedupeKey: key, kind: 'thumbnail', priority: 2, assetId: 'asset1' }, start)
  const job = claimNextJob(db, start)!
  const done = start + durationMs
  completeJob(db, job.id, done)
  return done
}

function queuedMedia(db: ReturnType<typeof seed>, key: string, at: number): void {
  enqueueJob(db, { dedupeKey: key, kind: 'thumbnail', priority: 2, assetId: 'asset1' }, at)
}

function asrJob(
  db: ReturnType<typeof seed>,
  id: string,
  assetId: string,
  at: number,
  maxAttempts = 3,
): void {
  createAsrJob(
    db,
    {
      id,
      assetId,
      fileVersion: 1,
      modelRevision: MODEL,
      alignerRevision: ALIGNER,
      pipelineVersion: PIPELINE,
      maxAttempts,
    },
    at,
  )
}

function embeddingJob(
  db: Db,
  id: string,
  assetId: string,
  at: number,
  maxAttempts = 3,
): void {
  createEmbeddingJob(
    db,
    {
      id,
      assetId,
      fileVersion: 1,
      sourceTranscriptId: null,
      modelId: 'Qwen/Qwen3-Embedding-4B-GGUF',
      modelRevision: 'commit-sha',
      modelSha256: 'sha-embed',
      pipelineVersion: 'embed-pipeline-1',
      dimensions: 2,
      maxAttempts,
    },
    at,
  )
}

function finishedEmbedding(
  db: Db,
  id: string,
  assetId: string,
  start: number,
  durationMs: number,
): number {
  embeddingJob(db, id, assetId, start)
  claimEmbeddingJob(db, `embed-${id}`, 120_000, start)
  const done = completeEmbeddingJob(
    db,
    {
      jobId: id,
      owner: `embed-${id}`,
      vectors: [
        {
          kind: 'title',
          chunkIndex: 0,
          startMs: null,
          endMs: null,
          text: assetId,
          vector: Float32Array.from([1, 0]),
        },
      ],
    },
    start + durationMs,
  )
  expect(done).toBe(true)
  return start + durationMs
}

/** A completed ASR row with a known claim-to-finish duration, without transcripts. */
function finishedAsrRow(db: Db, id: string, startedAt: number, durationMs: number): void {
  db.query(
    `INSERT INTO asr_jobs (
       id, asset_id, file_version, state, stage, progress, attempts, max_attempts,
       model_revision, aligner_revision, pipeline_version, created_at, updated_at, started_at
     ) VALUES (?, 'asset1', 1, 'completed', 'completed', 100, 1, 3, ?, ?, ?, ?, ?, ?)`,
  ).run(id, MODEL, ALIGNER, PIPELINE, startedAt, startedAt + durationMs, startedAt)
}

describe('work queue', () => {
  test('an idle queue reports zero and no estimate', () => {
    const db = seed()
    const queue = workQueue(db, 10_000, RESOURCE)

    expect(queue.remaining).toBe(0)
    expect(queue.etaSeconds).toBe(0)
    expect(queue.basis).toBeNull()
    expect(queue.running).toEqual([])
    expect(queue.lastCompletedAt).toBeNull()
    expect(queue.pipelines.every((lane) => lane.queued === 0 && lane.running === 0)).toBe(true)
  })

  test('counts are exact even when the item list is capped', () => {
    const db = seed()
    for (let index = 0; index < 60; index += 1) queuedMedia(db, `job-${index}`, 1_000)

    const queue = workQueue(db, 10_000, RESOURCE)

    expect(queue.remaining).toBe(60)
    expect(queue.queued).toHaveLength(50)
    expect(queue.pipelines[0]!.queued).toBe(60)
  })

  test('queued work is multiplied by the median of recent completions', () => {
    const db = seed()
    let now = 10_000
    now = finishedMedia(db, 'a', now, 30_000)
    now = finishedMedia(db, 'b', now, 40_000)
    now = finishedMedia(db, 'c', now, 50_000)
    queuedMedia(db, 'd', now)
    queuedMedia(db, 'e', now)

    const queue = workQueue(db, now + 1_000, RESOURCE)

    expect(queue.pipelines[0]!.etaSeconds).toBe(80)
    expect(queue.pipelines[0]!.basis).toBe('history')
    expect(queue.etaSeconds).toBe(80)
    expect(queue.basis).toBe('history')
  })

  test('a running job subtracts the time it already spent', () => {
    const db = seed()
    let now = 10_000
    now = finishedMedia(db, 'a', now, 30_000)
    now = finishedMedia(db, 'b', now, 40_000)
    now = finishedMedia(db, 'c', now, 50_000)
    queuedMedia(db, 'd', now)
    claimNextJob(db, now)

    const queue = workQueue(db, now + 30_000, RESOURCE)

    expect(queue.pipelines[0]!.running).toBe(1)
    expect(queue.pipelines[0]!.etaSeconds).toBe(10)
  })

  test('one completion is not enough history to promise a time', () => {
    const db = seed()
    const done = finishedMedia(db, 'a', 10_000, 30_000)
    queuedMedia(db, 'b', done)

    const queue = workQueue(db, done + 1_000, RESOURCE)

    expect(queue.pipelines[0]!.etaSeconds).toBeNull()
    expect(queue.etaSeconds).toBeNull()
    expect(queue.basis).toBe('insufficient_data')
  })

  test('an expired lease is stalled, counted, and never estimated', () => {
    const db = seed()
    asrJob(db, 'asr1', 'asset1', 1_000)
    claimAsrJob(db, 'asr-w', 1_000, 10_000)

    const queue = workQueue(db, 20_000, RESOURCE)

    expect(queue.stalled).toHaveLength(1)
    expect(queue.stalled[0]!.state).toBe('stalled')
    expect(queue.stalled[0]!.assetName).toBe('asset1.mp4')
    expect(queue.remaining).toBe(1)
    expect(queue.pipelines[1]!.stalled).toBe(1)
    expect(queue.pipelines[1]!.running).toBe(0)
    expect(queue.pipelines[1]!.etaSeconds).toBeNull()
    expect(queue.etaSeconds).toBeNull()
  })

  test('onGpu follows the lease owner, not the job state', () => {
    const db = seed()
    asrJob(db, 'asr1', 'asset1', 1_000)
    claimAsrJob(db, 'asr-w', 120_000, 10_000)

    expect(workQueue(db, 20_000, RESOURCE).running[0]!.onGpu).toBe(false)

    acquireGpuLease(
      db,
      { resourceId: RESOURCE, owner: 'asr-w', taskKind: 'asr', leaseMs: 120_000 },
      20_000,
    )

    expect(workQueue(db, 30_000, RESOURCE).running[0]!.onGpu).toBe(true)
  })

  test('failures from different queues carry the asset name and the error', () => {
    const db = seed()
    enqueueJob(
      db,
      { dedupeKey: 'thumb', kind: 'thumbnail', priority: 2, assetId: 'asset1', maxAttempts: 1 },
      1_000,
    )
    const media = claimNextJob(db, 1_000)!
    failJob(db, media.id, 'ffmpeg exited 1', 2_000)

    asrJob(db, 'asr1', 'asset2', 1_000, 1)
    claimAsrJob(db, 'asr-w', 120_000, 1_000)
    failAsrJob(db, 'asr1', 'audio stream missing', 3_000)

    const queue = workQueue(db, 4_000, RESOURCE)

    expect(queue.failures).toHaveLength(2)
    const [first, second] = queue.failures
    expect(first!.assetName).toBe('asset2.mp4')
    expect(first!.errorMessage).toBe('audio stream missing')
    expect(second!.assetName).toBe('asset1.mp4')
    expect(second!.errorMessage).toBe('ffmpeg exited 1')
    expect(first!.state).toBe('failed')
  })

  test('a failure that a newer attempt replaced is not listed', () => {
    const db = seed()
    enqueueJob(
      db,
      { dedupeKey: 'thumb', kind: 'thumbnail', priority: 2, assetId: 'asset1', maxAttempts: 1 },
      1_000,
    )
    const media = claimNextJob(db, 1_000)!
    failJob(db, media.id, 'ffmpeg exited 1', 2_000)
    // The same work is queued again, so the failure is history, not a live one.
    enqueueJob(db, { dedupeKey: 'thumb', kind: 'thumbnail', priority: 2, assetId: 'asset1' }, 3_000)

    const queue = workQueue(db, 4_000, RESOURCE)

    expect(queue.failures).toHaveLength(0)
    expect(queue.queued.some((item) => item.kind === 'thumbnail')).toBe(true)
  })

  test('an older ASR failure under a newer attempt is not listed', () => {
    const db = seed()
    asrJob(db, 'asr1', 'asset2', 1_000, 1)
    claimAsrJob(db, 'asr-w', 120_000, 1_000)
    failAsrJob(db, 'asr1', 'audio stream missing', 3_000)

    // The shape the old code left on the host: a second row for the same file.
    db.query(
      `INSERT INTO asr_jobs (
         id, asset_id, file_version, state, stage, progress, attempts, max_attempts,
         model_revision, aligner_revision, pipeline_version, created_at, updated_at
       ) VALUES ('asr2', 'asset2', 1, 'queued', 'queued', 0, 0, 3, ?, ?, 'asr-pipeline-2', 4000, 4000)`,
    ).run(MODEL, ALIGNER)

    const queue = workQueue(db, 5_000, RESOURCE)

    expect(queue.failures).toHaveLength(0)
    expect(queue.queued.some((item) => item.id === 'asr2')).toBe(true)
  })

  test('a failure for a library that no longer exists is not listed', () => {
    const db = seed()
    createLibrary(db, { id: 'lib2', name: 'Gone', rootPath: 'Gone', createdAt: 1 })
    enqueueJob(
      db,
      { dedupeKey: 'scan:lib2', kind: 'scan_library', priority: 2, libraryId: 'lib2', maxAttempts: 1 },
      1_000,
    )
    const job = claimNextJob(db, 1_000)!
    failJob(db, job.id, 'library lib2 no longer exists', 2_000)
    deleteLibrary(db, 'lib2')

    const queue = workQueue(db, 3_000, RESOURCE)

    expect(queue.failures).toHaveLength(0)
  })

  test('lastCompletedAt is the newest finish across the queues', () => {
    const db = seed()
    finishedMedia(db, 'a', 10_000, 5_000)
    const last = finishedMedia(db, 'b', 100_000, 7_000)

    expect(workQueue(db, 200_000, RESOURCE).lastCompletedAt).toBe(last)
  })

  test('the embedding lane estimates on its own and adds to the GPU total', () => {
    const db = seed()
    insertAsset(db, assetInput('asset4', 'folder1'))
    let now = 10_000
    now = finishedEmbedding(db, 'e1', 'asset1', now, 10_000)
    now = finishedEmbedding(db, 'e2', 'asset2', now, 20_000)
    now = finishedEmbedding(db, 'e3', 'asset3', now, 30_000)
    embeddingJob(db, 'e4', 'asset4', now)

    const queue = workQueue(db, now + 1_000, RESOURCE)
    const lane = queue.pipelines.find((item) => item.pipeline === 'embedding')!

    expect(lane.queued).toBe(1)
    expect(lane.etaSeconds).toBe(20)
    expect(lane.basis).toBe('history')
    expect(queue.remaining).toBe(1)
    expect(queue.etaSeconds).toBe(20)
  })

  test('a failed embedding job is listed with the other failures', () => {
    const db = seed()
    embeddingJob(db, 'e1', 'asset1', 1_000, 1)
    claimEmbeddingJob(db, 'embed-w', 120_000, 1_000)
    failEmbeddingJob(db, 'e1', 'llama-server exited 1', 2_000)

    const queue = workQueue(db, 3_000, RESOURCE)

    expect(queue.failures).toHaveLength(1)
    expect(queue.failures[0]!.pipeline).toBe('embedding')
    expect(queue.failures[0]!.kind).toBe('embedding')
    expect(queue.failures[0]!.assetName).toBe('asset1.mp4')
    expect(queue.failures[0]!.errorMessage).toBe('llama-server exited 1')
  })

  test('window planning mirrors the scene worker', () => {
    expect(sceneWindowCount(60_000, 10_000, 2_000)).toBe(8)
    expect(sceneWindowCount(60_000, 10_000, 2_000, 2)).toBe(2)
    expect(sceneWindowCount(5_000, 10_000, 2_000, 120)).toBe(1)
    expect(sceneWindowCount(0, 10_000, 2_000)).toBe(0)
  })

  test('the scene lane reports sampling and follows the lease', () => {
    const db = seed()
    createSceneJob(
      db,
      {
        id: 's1',
        assetId: 'asset1',
        fileVersion: 1,
        modelId: 'pe-av-base',
        modelRevision: 'rev1',
        modelSha256: 'sha1',
        pipelineVersion: '1',
        dimensions: 4,
        windowMs: 10_000,
        overlapMs: 2_000,
      },
      1_000,
    )
    claimSceneJob(db, 'scene-w', 120_000, 1_000)

    const waiting = workQueue(db, 2_000, RESOURCE, { maxSceneWindows: 2 })
    const waitingLane = waiting.pipelines.find((lane) => lane.pipeline === 'scene')!

    expect(waitingLane.running).toBe(1)
    expect(waitingLane.waitingGpu).toBe(1)
    expect(waitingLane.runningGpu).toBe(0)
    expect(waiting.running[0]!.onGpu).toBe(false)
    expect(waiting.running[0]!.waitingGpu).toBe(true)
    expect(waiting.running[0]!.coverage).toEqual({ analyzed: 2, total: 8, sampled: true })

    acquireGpuLease(
      db,
      { resourceId: RESOURCE, owner: 'scene-w', taskKind: 'scene', leaseMs: 120_000 },
      2_000,
    )

    const holding = workQueue(db, 3_000, RESOURCE, { maxSceneWindows: 2 })
    const holdingLane = holding.pipelines.find((lane) => lane.pipeline === 'scene')!

    expect(holdingLane.runningGpu).toBe(1)
    expect(holdingLane.waitingGpu).toBe(0)
    expect(holding.running[0]!.onGpu).toBe(true)
    expect(holding.running[0]!.waitingGpu).toBe(false)
  })

  test('a scene failure keeps its standard error code', () => {
    const db = seed()
    createSceneJob(
      db,
      {
        id: 's1',
        assetId: 'asset1',
        fileVersion: 1,
        modelId: 'pe-av-base',
        modelRevision: 'rev1',
        modelSha256: 'sha1',
        pipelineVersion: '1',
        dimensions: 4,
        windowMs: 10_000,
        overlapMs: 2_000,
        maxAttempts: 1,
      },
      1_000,
    )
    claimSceneJob(db, 'scene-w', 120_000, 1_000)
    failSceneJob(
      db,
      's1',
      formatJobError('PROCESS_TIMEOUT', 'scene stage exceeded 60s'),
      2_000,
    )

    const queue = workQueue(db, 3_000, RESOURCE)

    expect(queue.failures).toHaveLength(1)
    expect(queue.failures[0]!.pipeline).toBe('scene')
    expect(queue.failures[0]!.errorCode).toBe('PROCESS_TIMEOUT')
    expect(queue.failures[0]!.errorMessage).toBe('scene stage exceeded 60s')
  })

  test('a waiting GPU job finishes after the holder and the wait does not shrink it', () => {
    const db = seed()
    const start = 200_000
    // Both lanes have a 20s median from 10s, 20s and 30s completions.
    finishedAsrRow(db, 'a1', start - 100_000, 10_000)
    finishedAsrRow(db, 'a2', start - 80_000, 20_000)
    finishedAsrRow(db, 'a3', start - 60_000, 30_000)
    let done = start - 50_000
    done = finishedEmbedding(db, 'e1', 'asset1', done, 10_000)
    done = finishedEmbedding(db, 'e2', 'asset2', done, 20_000)
    finishedEmbedding(db, 'e3', 'asset3', done, 30_000)

    asrJob(db, 'a4', 'asset1', start)
    insertAsset(db, assetInput('asset4', 'folder1'))
    embeddingJob(db, 'e4', 'asset4', start)
    claimAsrJob(db, 'asr-w', 120_000, start)
    claimEmbeddingJob(db, 'embed-w', 120_000, start)
    acquireGpuLease(
      db,
      { resourceId: RESOURCE, owner: 'asr-w', taskKind: 'asr', leaseMs: 120_000 },
      start,
    )

    const early = workQueue(db, start + 5_000, RESOURCE)
    const earlyHolder = early.running.find((item) => item.id === 'a4')!
    const earlyWaiter = early.running.find((item) => item.id === 'e4')!

    expect(earlyHolder.onGpu).toBe(true)
    expect(earlyHolder.etaSeconds).toBe(15)
    // 15s left for the ASR holder plus this job's own 20s.
    expect(earlyWaiter.waitingGpu).toBe(true)
    expect(earlyWaiter.etaSeconds).toBe(35)
    expect(early.pipelines.find((lane) => lane.pipeline === 'embedding')!.etaSeconds).toBe(20)

    const later = workQueue(db, start + 15_000, RESOURCE)
    const laterWaiter = later.running.find((item) => item.id === 'e4')!

    // The waiter spent 10 more seconds waiting, not 10 seconds processing.
    expect(laterWaiter.etaSeconds).toBe(25)
  })
})
