import { describe, expect, test } from 'bun:test'
import {
  claimFaceJob,
  completeFaceJob,
  countPeople,
  createFaceJob,
  createLibrary,
  getPerson,
  insertAsset,
  listPeople,
  mergePeople,
  openDatabase,
  personAssets,
  personFaces,
  reclusterUnassigned,
  renamePerson,
  setPersonState,
  splitPerson,
  updateAssetFile,
  upsertFolder,
} from './index'
import type { CompleteFaceJobInput, CreateFaceJobInput } from './people'
import type { Db } from './db'
import type { NewAsset } from './assets'

const DIMENSIONS = 4
const SHA = 'face-sha-1'
const PIPELINE = 'face-pipeline-1'
const MATCH = 0.45
const CANDIDATE = 0.5

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

function unit(values: number[]): Float32Array {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
  return Float32Array.from(values.map((value) => value / norm))
}

function jobInput(overrides: Partial<CreateFaceJobInput> = {}): CreateFaceJobInput {
  return {
    id: 'face1',
    assetId: 'asset1',
    fileVersion: 1,
    modelId: 'antelopev2',
    modelRevision: 'v0.7',
    modelSha256: SHA,
    pipelineVersion: PIPELINE,
    dimensions: DIMENSIONS,
    sampleMs: 2_000,
    ...overrides,
  }
}

function face(frameMs: number, vector: Float32Array, score = 0.9) {
  return {
    frameMs,
    x: 10,
    y: 10,
    width: 80,
    height: 100,
    score,
    thumbnailPath: `faces/asset1/${String(frameMs).padStart(9, '0')}-0.jpg`,
    vector,
  }
}

function run(
  db: Db,
  assetId: string,
  jobId: string,
  faces: CompleteFaceJobInput['faces'],
  now = 5_000,
  overrides: Partial<CreateFaceJobInput> = {},
): boolean {
  createFaceJob(db, jobInput({ id: jobId, assetId, ...overrides }), now)
  const claimed = claimFaceJob(db, 'worker-a', 60_000, now)!
  return completeFaceJob(
    db,
    {
      jobId: claimed.id,
      owner: 'worker-a',
      matchThreshold: MATCH,
      candidateThreshold: CANDIDATE,
      faces,
    },
    now + 1_000,
  )
}

describe('face job lifecycle', () => {
  test('several face jobs can run at once, because the work is on the CPU', () => {
    const db = seed()
    createFaceJob(db, jobInput(), 1_000)
    createFaceJob(db, jobInput({ id: 'face2', assetId: 'asset2' }), 1_000)

    expect(claimFaceJob(db, 'worker-a', 60_000, 2_000)?.assetId).toBe('asset1')
    expect(claimFaceJob(db, 'worker-b', 60_000, 2_000)?.assetId).toBe('asset2')
    expect(claimFaceJob(db, 'worker-c', 60_000, 2_000)).toBeNull()
  })

  test('a complete for a file version the asset no longer has is rejected', () => {
    const db = seed()
    createFaceJob(db, jobInput(), 1_000)
    claimFaceJob(db, 'worker-a', 60_000, 2_000)

    updateAssetFile(db, 'asset1', {
      folderId: 'folder1',
      filename: 'asset1.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 2_000,
      mtimeMs: 2_000,
      width: 1_080,
      height: 1_920,
      durationMs: 30_000,
      takenAt: 10_000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      container: 'mov,mp4',
      indexedAt: 20_000,
      scanId: 'scan2',
    })

    expect(
      completeFaceJob(
        db,
        {
          jobId: 'face1',
          owner: 'worker-a',
          matchThreshold: MATCH,
          candidateThreshold: CANDIDATE,
          faces: [face(0, unit([1, 0, 0, 0]))],
        },
        3_000,
      ),
    ).toBe(false)

    const stale = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM face_detections WHERE asset_id = 'asset1' AND file_version = 1",
      )
      .get()
    expect(stale?.n).toBe(0)
  })

  test('a complete from a stale owner is ignored', () => {
    const db = seed()
    createFaceJob(db, jobInput(), 1_000)
    claimFaceJob(db, 'worker-a', 60_000, 2_000)

    expect(
      completeFaceJob(
        db,
        {
          jobId: 'face1',
          owner: 'worker-b',
          matchThreshold: MATCH,
          candidateThreshold: CANDIDATE,
          faces: [face(0, unit([1, 0, 0, 0]))],
        },
        3_000,
      ),
    ).toBe(false)
    expect(countPeople(db, 'all')).toBe(0)
  })
})

describe('people assignment', () => {
  test('a face that matches nobody seeds a candidate', () => {
    const db = seed()
    run(db, 'asset1', 'face1', [face(0, unit([1, 0, 0, 0]))])

    const people = listPeople(db, 'candidate', 10)
    expect(people).toHaveLength(1)
    expect(people[0]?.faceCount).toBe(1)
    expect(people[0]?.assetCount).toBe(1)
  })

  test('two videos of one face land in the same candidate', () => {
    const db = seed()
    run(db, 'asset1', 'face1', [face(0, unit([1, 0, 0, 0]))])
    run(db, 'asset2', 'face2', [face(2_000, unit([0.99, 0.01, 0, 0]))], 9_000)

    const people = listPeople(db, 'candidate', 10)
    expect(people).toHaveLength(1)
    expect(people[0]?.faceCount).toBe(2)
    expect(people[0]?.assetCount).toBe(2)
    expect(personAssets(db, people[0]!.id)).toHaveLength(2)
  })

  test('two different faces stay apart', () => {
    const db = seed()
    run(db, 'asset1', 'face1', [face(0, unit([1, 0, 0, 0]))])
    run(db, 'asset2', 'face2', [face(2_000, unit([0, 1, 0, 0]))], 9_000)

    expect(listPeople(db, 'candidate', 10)).toHaveLength(2)
  })

  test('an approved person wins over a candidate at the same similarity', () => {
    const db = seed()
    run(db, 'asset1', 'face1', [face(0, unit([1, 0, 0, 0]))])
    const candidate = listPeople(db, 'candidate', 10)[0]!
    setPersonState(db, candidate.id, 'approved', null, 6_000)

    // A second face is close enough to the approved centroid but also seeds
    // nothing new: it must join the approved person, not a new group.
    run(db, 'asset2', 'face2', [face(2_000, unit([1, 0.01, 0, 0]))], 9_000)

    const approved = listPeople(db, 'approved', 10)
    expect(approved).toHaveLength(1)
    expect(approved[0]?.faceCount).toBe(2)
    expect(countPeople(db, 'candidate')).toBe(0)
  })

  test('an excluded person never appears in the approved list', () => {
    const db = seed()
    run(db, 'asset1', 'face1', [face(0, unit([1, 0, 0, 0]))])
    const person = listPeople(db, 'candidate', 10)[0]!

    setPersonState(db, person.id, 'excluded', null, 6_000)

    expect(listPeople(db, 'approved', 10)).toHaveLength(0)
    expect(listPeople(db, 'candidate', 10)).toHaveLength(0)
    expect(listPeople(db, 'excluded', 10)).toHaveLength(1)
  })

  test('a re-run of one asset replaces its detections and refreshes the person', () => {
    const db = seed()
    run(db, 'asset1', 'face1', [face(0, unit([1, 0, 0, 0]))])
    const personId = listPeople(db, 'candidate', 10)[0]!.id

    run(db, 'asset1', 'face1-again', [face(4_000, unit([1, 0, 0, 0]))], 9_000, {
      pipelineVersion: 'face-pipeline-2',
    })

    const person = getPerson(db, personId)
    expect(person?.faceCount).toBe(1)
    expect(personFaces(db, personId, 10)[0]?.frameMs).toBe(4_000)
  })
})

describe('people review', () => {
  test('rename keeps the faces and records the change', () => {
    const db = seed()
    run(db, 'asset1', 'face1', [face(0, unit([1, 0, 0, 0]))])
    const personId = listPeople(db, 'candidate', 10)[0]!.id

    const renamed = renamePerson(db, personId, '민수', null, 6_000)

    expect(renamed?.name).toBe('민수')
    expect(renamed?.faceCount).toBe(1)
    const actions = db
      .query<{ action: string }, []>('SELECT action FROM person_review_actions')
      .all()
    expect(actions.map((row) => row.action)).toContain('rename')
  })

  test('merge moves every face into the target and drops the source', () => {
    const db = seed()
    run(db, 'asset1', 'face1', [face(0, unit([1, 0, 0, 0]))])
    run(db, 'asset2', 'face2', [face(2_000, unit([0, 1, 0, 0]))], 9_000)
    const [first, second] = listPeople(db, 'candidate', 10)

    const merged = mergePeople(db, first!.id, second!.id, null, 10_000)

    expect(merged?.id).toBe(second!.id)
    expect(merged?.faceCount).toBe(2)
    expect(getPerson(db, first!.id)).toBeNull()
    expect(countPeople(db, 'all')).toBe(1)
  })

  test('split moves the named detections into a new candidate', () => {
    const db = seed()
    run(db, 'asset1', 'face1', [face(0, unit([1, 0, 0, 0]))])
    run(db, 'asset2', 'face2', [face(2_000, unit([1, 0.01, 0, 0]))], 9_000)
    const person = listPeople(db, 'candidate', 10)[0]!
    expect(person.faceCount).toBe(2)
    const detections = personFaces(db, person.id, 10)

    const created = splitPerson(db, person.id, [detections[0]!.detectionId], '새 인물', null, 10_000)

    expect(created?.faceCount).toBe(1)
    expect(getPerson(db, person.id)?.faceCount).toBe(1)
  })

  test('splitting every face is refused', () => {
    const db = seed()
    run(db, 'asset1', 'face1', [face(0, unit([1, 0, 0, 0]))])
    const person = listPeople(db, 'candidate', 10)[0]!
    const detections = personFaces(db, person.id, 10)

    expect(splitPerson(db, person.id, [detections[0]!.detectionId], '새 인물', null, 6_000)).toBeNull()
  })

  test('a rescan drops candidates and regroups their faces, keeping approved people', () => {
    const db = seed()
    run(db, 'asset1', 'face1', [face(0, unit([1, 0, 0, 0]))])
    const approved = listPeople(db, 'candidate', 10)[0]!
    setPersonState(db, approved.id, 'approved', null, 6_000)
    run(db, 'asset2', 'face2', [face(2_000, unit([0, 1, 0, 0]))], 9_000)
    expect(countPeople(db, 'candidate')).toBe(1)

    const dropped = reclusterUnassigned(db, MATCH, CANDIDATE, null, 10_000)

    expect(dropped).toBe(1)
    expect(countPeople(db, 'approved')).toBe(1)
    expect(countPeople(db, 'candidate')).toBe(1)
    expect(getPerson(db, approved.id)?.faceCount).toBe(1)
  })
})
