import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  deleteStageCheckpoints,
  getStageCheckpoint,
  openDatabase,
  upsertStageCheckpoint,
  type StageCheckpointInput,
} from './index'
import { MIGRATIONS, SCHEMA_VERSION } from './schema'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const CHECKPOINT: StageCheckpointInput = {
  jobId: 'job1',
  pipeline: 'scene',
  assetId: 'asset1',
  fileVersion: 1,
  modelFingerprint: 'model@rev#sha',
  pipelineVersion: 'scene-1',
  stageName: 'extracting',
  completedUnits: 5,
  totalUnits: 120,
  artifactManifest: '/cache/scene-checkpoints/job1/manifest.json',
  manifestHash: 'a'.repeat(64),
}

describe('schema v21 stage checkpoints', () => {
  test('a v20 database gains the checkpoint table and keeps its scene rows', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mv-v21-'))
    dirs.push(dir)
    const file = path.join(dir, 'legacy.db')

    const legacy = new Database(file)
    for (let index = 0; index < 20; index += 1) {
      MIGRATIONS[index]!((sql) => legacy.exec(sql))
    }
    legacy.exec('PRAGMA user_version = 20')
    legacy
      .query(
        `INSERT INTO scene_jobs (
           id, asset_id, file_version, state, stage, progress, attempts, max_attempts,
           model_id, model_revision, model_sha256, pipeline_version, dimensions,
           window_ms, overlap_ms, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'job1',
        'asset1',
        1,
        'queued',
        'queued',
        0,
        0,
        3,
        'model',
        'rev',
        'sha',
        'scene-1',
        4,
        10_000,
        2_000,
        1_000,
        1_000,
      )
    legacy.close()

    const db = openDatabase(file)

    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(
      SCHEMA_VERSION,
    )
    expect(SCHEMA_VERSION).toBe(21)
    const row = db
      .query<
        {
          state: string
          modelSha256: string
          analyzedWindows: number | null
          totalWindows: number | null
        },
        []
      >(
        `SELECT state, model_sha256 AS modelSha256, analyzed_windows AS analyzedWindows,
                total_windows AS totalWindows
         FROM scene_jobs WHERE id = 'job1'`,
      )
      .get()!
    expect(row).toEqual({
      state: 'queued',
      modelSha256: 'sha',
      analyzedWindows: null,
      totalWindows: null,
    })
    const table = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stage_checkpoints'",
      )
      .get()
    expect(table?.name).toBe('stage_checkpoints')
  })

  test('a checkpoint is upserted per job and stage, then deleted with the job', () => {
    const db = openDatabase(':memory:')

    upsertStageCheckpoint(db, CHECKPOINT, 100)
    const advanced = upsertStageCheckpoint(db, { ...CHECKPOINT, completedUnits: 10 }, 200)
    upsertStageCheckpoint(db, { ...CHECKPOINT, stageName: 'writing', completedUnits: 1 }, 300)

    expect(advanced.completedUnits).toBe(10)
    expect(advanced.updatedAt).toBe(200)
    expect(getStageCheckpoint(db, 'job1', 'extracting')).toMatchObject({
      completedUnits: 10,
      totalUnits: 120,
      manifestHash: CHECKPOINT.manifestHash,
    })
    expect(getStageCheckpoint(db, 'job1', 'writing')?.completedUnits).toBe(1)

    expect(deleteStageCheckpoints(db, 'job1')).toBe(2)
    expect(getStageCheckpoint(db, 'job1', 'extracting')).toBeNull()
  })
})
