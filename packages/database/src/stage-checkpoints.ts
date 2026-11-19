import type { SQLQueryBindings } from 'bun:sqlite'
import type { Db } from './db'
import type { StageCheckpointRecord } from './types'

type Params = SQLQueryBindings[]

const COLUMNS = `
  job_id AS jobId, pipeline, asset_id AS assetId, file_version AS fileVersion,
  model_fingerprint AS modelFingerprint, pipeline_version AS pipelineVersion,
  stage_name AS stageName, completed_units AS completedUnits,
  total_units AS totalUnits, artifact_manifest AS artifactManifest,
  manifest_hash AS manifestHash, updated_at AS updatedAt
`

export interface StageCheckpointInput {
  jobId: string
  pipeline: string
  assetId: string
  fileVersion: number
  modelFingerprint: string
  pipelineVersion: string
  stageName: string
  completedUnits: number
  totalUnits: number
  artifactManifest: string
  manifestHash: string
}

/**
 * The row is only a pointer: the artifact and its manifest live on the worker
 * volume, and a resume reads both before trusting either.
 */
export function upsertStageCheckpoint(
  db: Db,
  input: StageCheckpointInput,
  now: number,
): StageCheckpointRecord {
  return db
    .query<StageCheckpointRecord, Params>(
      `INSERT INTO stage_checkpoints (
         job_id, pipeline, asset_id, file_version, model_fingerprint, pipeline_version,
         stage_name, completed_units, total_units, artifact_manifest, manifest_hash, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id, stage_name) DO UPDATE SET
         pipeline = excluded.pipeline,
         asset_id = excluded.asset_id,
         file_version = excluded.file_version,
         model_fingerprint = excluded.model_fingerprint,
         pipeline_version = excluded.pipeline_version,
         completed_units = excluded.completed_units,
         total_units = excluded.total_units,
         artifact_manifest = excluded.artifact_manifest,
         manifest_hash = excluded.manifest_hash,
         updated_at = excluded.updated_at
       RETURNING ${COLUMNS}`,
    )
    .get(
      input.jobId,
      input.pipeline,
      input.assetId,
      input.fileVersion,
      input.modelFingerprint,
      input.pipelineVersion,
      input.stageName,
      input.completedUnits,
      input.totalUnits,
      input.artifactManifest,
      input.manifestHash,
      now,
    )!
}

export function getStageCheckpoint(
  db: Db,
  jobId: string,
  stageName: string,
): StageCheckpointRecord | null {
  return (
    db
      .query<StageCheckpointRecord, Params>(
        `SELECT ${COLUMNS} FROM stage_checkpoints WHERE job_id = ? AND stage_name = ?`,
      )
      .get(jobId, stageName) ?? null
  )
}

export function deleteStageCheckpoints(db: Db, jobId: string): number {
  return db.query<null, Params>('DELETE FROM stage_checkpoints WHERE job_id = ?').run(jobId).changes
}
