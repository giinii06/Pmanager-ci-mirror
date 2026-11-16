import { afterEach, describe, expect, test } from 'bun:test'
import {
  acquireGpuLease,
  createAsrJob,
  createLibrary,
  getGpuLease,
  heartbeatGpuLease,
  insertAsset,
  openDatabase,
  releaseGpuLease,
  upsertFolder,
} from './index'
import type { NewAsset } from './assets'
import type { Db } from './db'

const RESOURCE = 'gpu:0'

const dbs: Db[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

function seed(): Db {
  const db = openDatabase(':memory:')
  dbs.push(db)
  createLibrary(db, { id: 'lib1', name: 'Videos', rootPath: 'Videos', createdAt: 1 })
  upsertFolder(db, {
    id: 'folder1',
    libraryId: 'lib1',
    parentId: null,
    relativePath: 'Videos',
    name: 'Videos',
    depth: 0,
    scanId: 'scan1',
  })
  insertAsset(db, asset('asset1'))
  insertAsset(db, asset('asset2'))
  return db
}

function asset(id: string): NewAsset {
  return {
    id,
    libraryId: 'lib1',
    folderId: 'folder1',
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

/** A queued ASR job is what "the ASR worker is waiting for the card" looks like. */
function queueAsr(db: Db): void {
  createAsrJob(
    db,
    {
      id: 'asr1',
      assetId: 'asset1',
      fileVersion: 1,
      modelRevision: 'asr-rev',
      alignerRevision: 'aligner-rev',
      pipelineVersion: 'asr-1',
    },
    1_000,
  )
}

function acquire(db: Db, owner: string, taskKind: string, now: number): boolean {
  return acquireGpuLease(db, { resourceId: RESOURCE, owner, taskKind, leaseMs: 120_000 }, now)
}

describe('gpu lease fairness', () => {
  test('a released lease is handed to another kind at once', () => {
    const db = seed()

    expect(acquire(db, 'scene-1', 'scene', 1_000)).toBe(true)
    expect(releaseGpuLease(db, RESOURCE, 'scene-1', 2_000)).toBe(true)

    expect(acquire(db, 'asr-1', 'asr', 2_000)).toBe(true)
    expect(getGpuLease(db, RESOURCE)?.taskKind).toBe('asr')
  })

  test('the kind that just released steps back while another kind waits', () => {
    const db = seed()
    queueAsr(db)

    expect(acquire(db, 'scene-1', 'scene', 1_000)).toBe(true)
    expect(releaseGpuLease(db, RESOURCE, 'scene-1', 2_000)).toBe(true)

    // The scene worker would otherwise re-acquire in the same millisecond and
    // keep the ASR worker out for the whole queue.
    expect(acquire(db, 'scene-1', 'scene', 2_000)).toBe(false)
    expect(acquire(db, 'asr-1', 'asr', 3_000)).toBe(true)
  })

  test('the pause ends so a queue nobody works cannot hold the card', () => {
    const db = seed()
    queueAsr(db)

    expect(acquire(db, 'scene-1', 'scene', 1_000)).toBe(true)
    expect(releaseGpuLease(db, RESOURCE, 'scene-1', 2_000)).toBe(true)

    expect(acquire(db, 'scene-1', 'scene', 2_000 + 14_999)).toBe(false)
    expect(acquire(db, 'scene-1', 'scene', 2_000 + 15_000)).toBe(true)
  })

  test('a released kind that nobody waits for takes the card back at once', () => {
    const db = seed()

    expect(acquire(db, 'scene-1', 'scene', 1_000)).toBe(true)
    expect(releaseGpuLease(db, RESOURCE, 'scene-1', 2_000)).toBe(true)

    expect(acquire(db, 'scene-1', 'scene', 2_000)).toBe(true)
  })

  test('a released row is not a lease, so it cannot be renewed', () => {
    const db = seed()

    expect(acquire(db, 'scene-1', 'scene', 1_000)).toBe(true)
    expect(releaseGpuLease(db, RESOURCE, 'scene-1', 2_000)).toBe(true)

    expect(getGpuLease(db, RESOURCE)).toBeNull()
    expect(heartbeatGpuLease(db, RESOURCE, 'scene-1', 2_000)).toBe(false)
  })

  test('a kind that does not share the card keeps its old behaviour', () => {
    const db = seed()
    queueAsr(db)

    expect(acquire(db, 'media-1', 'hls', 1_000)).toBe(true)
    expect(releaseGpuLease(db, RESOURCE, 'media-1', 2_000)).toBe(true)

    // Playback encodes fall back to the CPU instead of waiting, so they never
    // pause for the card.
    expect(acquire(db, 'media-1', 'hls', 2_000)).toBe(true)
  })
})
