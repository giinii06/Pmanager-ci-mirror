import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  cancelSceneJob,
  claimSceneJob,
  completeSceneJob,
  countScenesForAsset,
  createLibrary,
  createSceneJob,
  failSceneJob,
  getCurrentScenes,
  getScene,
  getSceneJob,
  heartbeatSceneJob,
  insertAsset,
  openDatabase,
  recoverExpiredSceneJobs,
  searchScenes,
  updateSceneProgress,
  upsertFolder,
} from './index'
import { MIGRATIONS, SCHEMA_VERSION } from './schema'
import type { CompleteSceneJobInput, CreateSceneJobInput } from './scenes'
import type { Db } from './db'
import type { NewAsset } from './assets'

const DIMENSIONS = 4
const SHA = 'scene-sha-1'
const PIPELINE = 'scene-pipeline-1'

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
    durationMs: 30_000,
    takenAt: 10_000,
    videoCodec: 'h264',
    audioCodec: 'aac',
    container: 'mov,mp4',
    indexedAt: 20_000,
    scanId: 'scan1',
  }
}

function seed(assets = ['asset1', 'asset2']): Db {
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
  for (const id of assets) insertAsset(db, assetInput(id, folderId))
  return db
}

function jobInput(overrides: Partial<CreateSceneJobInput> = {}): CreateSceneJobInput {
  return {
    id: 'scene1',
    assetId: 'asset1',
    fileVersion: 1,
    modelId: 'facebook/pe-av-base-16-frame',
    modelRevision: 'commit-sha',
    modelSha256: SHA,
    pipelineVersion: PIPELINE,
    dimensions: DIMENSIONS,
    windowMs: 10_000,
    overlapMs: 2_000,
    ...overrides,
  }
}

function unit(values: number[]): Float32Array {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
  return Float32Array.from(values.map((value) => value / norm))
}

function scene(seq: number, visual: number[], audio: number[], av: number[]) {
  return {
    seq,
    startMs: seq * 8_000,
    endMs: seq * 8_000 + 10_000,
    thumbnailPath: `scenes/asset1/${String(seq).padStart(4, '0')}.jpg`,
    visual: unit(visual),
    audio: unit(audio),
    av: unit(av),
  }
}

function completeInput(overrides: Partial<CompleteSceneJobInput> = {}): CompleteSceneJobInput {
  return {
    jobId: 'scene1',
    owner: 'worker-a',
    scenes: [scene(0, [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0])],
    ...overrides,
  }
}

function claim(db: Db, now = 5_000) {
  createSceneJob(db, jobInput(), now)
  return claimSceneJob(db, 'worker-a', 60_000, now)!
}

describe('scene job lifecycle', () => {
  test('only one scene job runs at a time', () => {
    const db = seed()
    createSceneJob(db, jobInput(), 1_000)
    createSceneJob(db, jobInput({ id: 'scene2', assetId: 'asset2' }), 1_000)

    const first = claimSceneJob(db, 'worker-a', 60_000, 2_000)

    expect(first?.assetId).toBe('asset1')
    expect(claimSceneJob(db, 'worker-b', 60_000, 2_000)).toBeNull()
  })

  test('a finished job is not re-claimed until it goes stale', () => {
    const db = seed()
    claim(db)
    completeSceneJob(db, completeInput(), 6_000)

    createSceneJob(db, jobInput({ id: 'scene-again' }), 7_000)

    expect(claimSceneJob(db, 'worker-a', 60_000, 8_000)).toBeNull()
  })

  test('a new window plan resets a completed row', () => {
    const db = seed()
    claim(db)
    completeSceneJob(db, completeInput(), 6_000)

    const reset = createSceneJob(db, jobInput({ windowMs: 5_000 }), 7_000)

    expect(reset.id).toBe('scene1')
    expect(reset.state).toBe('queued')
    expect(reset.windowMs).toBe(5_000)
    expect(claimSceneJob(db, 'worker-a', 60_000, 8_000)?.id).toBe('scene1')
  })

  test('heartbeat and progress need the live lease', () => {
    const db = seed()
    claim(db, 5_000)

    expect(heartbeatSceneJob(db, 'scene1', 'worker-b', 6_000)).toBe(false)
    expect(heartbeatSceneJob(db, 'scene1', 'worker-a', 6_000)).toBe(true)
    expect(updateSceneProgress(db, 'scene1', 'worker-a', { state: 'embedding', stage: 'embedding', progress: 40 }, 6_500)).toBe(true)
    expect(getSceneJob(db, 'scene1')?.progress).toBe(40)
  })

  test('an expired lease is recovered for another attempt', () => {
    const db = seed()
    claim(db, 5_000)

    expect(recoverExpiredSceneJobs(db, 100_000)).toBe(1)
    expect(getSceneJob(db, 'scene1')?.state).toBe('queued')
    expect(claimSceneJob(db, 'worker-b', 60_000, 100_001)?.id).toBe('scene1')
  })

  test('a failed job retries with a backoff and then gives up', () => {
    const db = seed()
    createSceneJob(db, jobInput({ maxAttempts: 2 }), 1_000)

    for (const attempt of [1, 2]) {
      claimSceneJob(db, 'worker-a', 60_000, attempt * 10_000)
      const state = failSceneJob(db, 'scene1', 'the stage died', attempt * 10_000)
      expect(state).toBe(attempt === 1 ? 'queued' : 'failed')
    }
  })

  test('a cancel leaves a finished job alone', () => {
    const db = seed()
    claim(db)
    completeSceneJob(db, completeInput(), 6_000)

    cancelSceneJob(db, 'scene1', 7_000)

    expect(getSceneJob(db, 'scene1')?.state).toBe('completed')
  })
})

describe('scene results', () => {
  test('a complete writes one row and three vectors per window', () => {
    const db = seed()
    claim(db)

    expect(completeSceneJob(db, completeInput(), 6_000)).toBe(true)

    const scenes = getCurrentScenes(db, 'asset1', 1, { modelSha256: SHA, pipelineVersion: PIPELINE })
    expect(scenes).toHaveLength(1)
    expect(scenes[0]?.thumbnailPath).toBe('scenes/asset1/0000.jpg')
    expect(getScene(db, scenes[0]!.id)?.endMs).toBe(10_000)
  })

  test('a stale owner cannot write results', () => {
    const db = seed()
    claim(db)

    expect(completeSceneJob(db, completeInput({ owner: 'worker-b' }), 6_000)).toBe(false)
    expect(countScenesForAsset(db, 'asset1')).toBe(0)
  })

  test('a re-run replaces the windows instead of appending them', () => {
    const db = seed()
    claim(db)
    completeSceneJob(db, completeInput(), 6_000)

    createSceneJob(db, jobInput({ pipelineVersion: 'scene-pipeline-2' }), 7_000)
    claimSceneJob(db, 'worker-a', 60_000, 8_000)
    completeSceneJob(
      db,
      completeInput({
        scenes: [
          scene(0, [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]),
          scene(1, [0, 1, 0, 0], [1, 0, 0, 0], [0, 0, 0, 1]),
        ],
      }),
      9_000,
    )

    expect(countScenesForAsset(db, 'asset1')).toBe(2)
    expect(
      getCurrentScenes(db, 'asset1', 1, { modelSha256: SHA, pipelineVersion: 'scene-pipeline-1' }),
    ).toHaveLength(0)
  })

  test('a vector that is not unit length is refused', () => {
    const db = seed()
    claim(db)

    expect(() =>
      completeSceneJob(
        db,
        completeInput({
          scenes: [
            {
              seq: 0,
              startMs: 0,
              endMs: 10_000,
              thumbnailPath: 'scenes/asset1/0000.jpg',
              visual: Float32Array.from([2, 0, 0, 0]),
              audio: unit([0, 1, 0, 0]),
              av: unit([0, 0, 1, 0]),
            },
          ],
        }),
        6_000,
      ),
    ).toThrow(/norm/)
  })

  test('a deleted asset takes its results with it', () => {
    const db = seed()
    claim(db)
    completeSceneJob(db, completeInput(), 6_000)
    db.query('UPDATE assets SET deleted_at = 100 WHERE id = ?').run('asset1')

    expect(
      searchScenes(
        db,
        { visual: unit([1, 0, 0, 0]), audio: unit([0, 1, 0, 0]), av: unit([0, 0, 1, 0]) },
        { modelSha256: SHA, pipelineVersion: PIPELINE, dimensions: DIMENSIONS },
        10,
      ),
    ).toHaveLength(0)
  })
})

describe('scene search', () => {
  test('each modality ranks against its own column', () => {
    const db = seed()
    claim(db)
    completeSceneJob(
      db,
      completeInput({
        scenes: [
          scene(0, [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]),
          scene(1, [0, 0, 1, 0], [1, 0, 0, 0], [0, 1, 0, 0]),
        ],
      }),
      6_000,
    )

    const byVisual = searchScenes(
      db,
      { visual: unit([1, 0, 0, 0]), audio: unit([0, 1, 0, 0]), av: unit([0, 0, 1, 0]) },
      { modelSha256: SHA, pipelineVersion: PIPELINE, dimensions: DIMENSIONS },
      10,
    )

    expect(byVisual[0]?.seq).toBe(0)
    expect(byVisual[0]?.modality).toBe('visual')
    expect(byVisual[0]?.score).toBeCloseTo(1)
    expect(byVisual[1]?.seq).toBe(1)
  })

  test('a scene is scored by its best modality, not the sum', () => {
    const db = seed()
    claim(db)
    completeSceneJob(
      db,
      completeInput({ scenes: [scene(0, [1, 0, 0, 0], [0, 0, 0, 1], [0, 0, 1, 0])] }),
      6_000,
    )

    const hits = searchScenes(
      db,
      { visual: unit([1, 0, 0, 0]), audio: unit([0, 0, 0, 1]), av: unit([0, 1, 0, 0]) },
      { modelSha256: SHA, pipelineVersion: PIPELINE, dimensions: DIMENSIONS },
      10,
    )

    expect(hits).toHaveLength(1)
    expect(hits[0]?.score).toBeCloseTo(1)
  })

  test('a different pipeline or dimension returns nothing', () => {
    const db = seed()
    claim(db)
    completeSceneJob(db, completeInput(), 6_000)

    const query = {
      visual: unit([1, 0, 0, 0]),
      audio: unit([0, 1, 0, 0]),
      av: unit([0, 0, 1, 0]),
    }
    expect(
      searchScenes(db, query, { modelSha256: SHA, pipelineVersion: 'other', dimensions: DIMENSIONS }, 10),
    ).toHaveLength(0)
    expect(
      searchScenes(db, query, { modelSha256: SHA, pipelineVersion: PIPELINE, dimensions: 8 }, 10),
    ).toHaveLength(0)
  })
})

describe('migration', () => {
  test('a version 7 database gains the scene and face tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mediavault-migrate-'))
    const path = join(dir, 'library.sqlite')
    try {
      const old = new Database(path, { create: true })
      old.exec('PRAGMA foreign_keys = ON')
      for (let index = 0; index < 7; index += 1) {
        MIGRATIONS[index]!((sql) => old.exec(sql))
      }
      old.exec('PRAGMA user_version = 7')
      old.close()

      const db = openDatabase(path)
      const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()
      expect(version?.user_version).toBe(SCHEMA_VERSION)

      const tables = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name)
      for (const name of [
        'scene_jobs',
        'video_scenes',
        'scene_embeddings',
        'face_jobs',
        'face_detections',
        'face_embeddings',
        'people',
        'person_faces',
        'person_assets',
        'person_review_actions',
      ]) {
        expect(tables).toContain(name)
      }
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
