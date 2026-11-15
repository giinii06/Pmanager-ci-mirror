import type {
  AsrJobState,
  AsrStage,
  AssetKind,
  EmbeddingJobState,
  EmbeddingStage,
  FaceJobState,
  FaceStage,
  JobKind,
  JobState,
  PersonState,
  ScanState,
  SceneJobState,
  SceneStage,
  TranslationJobState,
  TranslationStage,
} from '@mediavault/shared'

export interface LibraryRecord {
  id: string
  name: string
  rootPath: string
  createdAt: number
  lastScanAt: number | null
  scanState: ScanState
  scannedFiles: number
  lastError: string | null
  assetCount: number
  folderCount: number
}

export interface FolderRecord {
  id: string
  libraryId: string
  parentId: string | null
  name: string
  relativePath: string
  depth: number
  assetCount: number
  directImageCount: number
  coverAssetId: string | null
}

export interface AssetRow {
  id: string
  libraryId: string
  folderId: string | null
  relativePath: string
  filename: string
  kind: AssetKind
  mimeType: string
  sizeBytes: number
  mtimeMs: number
  width: number | null
  height: number | null
  durationMs: number | null
  takenAt: number
  fileVersion: number
  videoCodec: string | null
  audioCodec: string | null
  container: string | null
  favorite: number
}

export type AssetRecord = Omit<AssetRow, 'favorite'> & { favorite: boolean }

export interface ScanAssetRow {
  id: string
  sizeBytes: number
  mtimeMs: number
  fileVersion: number
  deletedAt: number | null
  lastSeenScan: string | null
}

export interface AssetFileInfo {
  id: string
  libraryId: string
  folderId: string | null
  relativePath: string
  filename: string
  kind: AssetKind
  mimeType: string
  fileVersion: number
  width: number | null
  height: number | null
  durationMs: number | null
  deletedAt: number | null
}

export interface JobRecord {
  id: number
  kind: JobKind
  state: JobState
  priority: number
  assetId: string | null
  libraryId: string | null
  payload: string | null
  attempts: number
  maxAttempts: number
  lastError: string | null
  startedAt: number | null
  updatedAt: number
}

export interface UserRecord {
  id: string
  username: string
  passwordHash: string
  createdAt: number
}

export interface PlaybackRecord {
  assetId: string
  positionMs: number
  durationMs: number
  updatedAt: number
}

export interface AsrJobRecord {
  id: string
  assetId: string
  fileVersion: number
  state: AsrJobState
  stage: AsrStage
  progress: number
  attempts: number
  maxAttempts: number
  leaseOwner: string | null
  leaseExpiresAt: number | null
  runAfter: number
  modelRevision: string
  alignerRevision: string
  pipelineVersion: string
  errorMessage: string | null
  startedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface TranscriptRecord {
  id: string
  jobId: string
  assetId: string
  fileVersion: number
  language: string
  resultDir: string
  plainText: string
  modelRevision: string
  alignerRevision: string
  pipelineVersion: string
  createdAt: number
}

export interface TranscriptSegmentRecord {
  seq: number
  startMs: number
  endMs: number
  text: string
}

export interface TranscriptWithSegments {
  transcript: TranscriptRecord
  segments: TranscriptSegmentRecord[]
}

export interface TranslationJobRecord {
  id: string
  sourceTranscriptId: string
  assetId: string
  fileVersion: number
  sourceLanguage: string
  targetLanguage: string
  state: TranslationJobState
  stage: TranslationStage
  progress: number
  attempts: number
  maxAttempts: number
  leaseOwner: string | null
  leaseExpiresAt: number | null
  runAfter: number
  modelId: string
  modelRevision: string
  modelSha256: string
  promptVersion: string
  pipelineVersion: string
  errorMessage: string | null
  startedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface TranslationRecord {
  id: string
  jobId: string
  sourceTranscriptId: string
  assetId: string
  fileVersion: number
  sourceLanguage: string
  targetLanguage: string
  plainText: string
  resultDir: string
  modelId: string
  modelRevision: string
  modelSha256: string
  promptVersion: string
  pipelineVersion: string
  createdAt: number
}

export interface TranslationSegmentRecord {
  seq: number
  startMs: number
  endMs: number
  text: string
}

export interface TranslationWithSegments {
  translation: TranslationRecord
  segments: TranslationSegmentRecord[]
}

export interface GpuLeaseRecord {
  resourceId: string
  owner: string
  taskKind: string
  leaseExpiresAt: number
  updatedAt: number
}

export interface EmbeddingJobRecord {
  id: string
  assetId: string
  fileVersion: number
  /** Null when the asset had no transcript, so the filename alone is embedded. */
  sourceTranscriptId: string | null
  state: EmbeddingJobState
  stage: EmbeddingStage
  progress: number
  attempts: number
  maxAttempts: number
  leaseOwner: string | null
  leaseExpiresAt: number | null
  runAfter: number
  modelId: string
  modelRevision: string
  modelSha256: string
  pipelineVersion: string
  dimensions: number
  errorMessage: string | null
  startedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface VideoEmbeddingRecord {
  id: string
  jobId: string
  assetId: string
  fileVersion: number
  sourceTranscriptId: string | null
  kind: 'title' | 'chunk'
  chunkIndex: number
  startMs: number | null
  endMs: number | null
  text: string
  modelSha256: string
  pipelineVersion: string
  dimensions: number
  vector: Float32Array
  createdAt: number
}

/** Everything that makes a stored vector stale when it changes. */
export interface EmbeddingFingerprint {
  modelSha256: string
  pipelineVersion: string
  dimensions: number
}

export interface ReviewRecord {
  id: string
  assetId: string
  userId: string
  rating: number
  body: string
  createdAt: number
  updatedAt: number
}

export interface SceneJobRecord {
  id: string
  assetId: string
  fileVersion: number
  state: SceneJobState
  stage: SceneStage
  progress: number
  attempts: number
  maxAttempts: number
  leaseOwner: string | null
  leaseExpiresAt: number | null
  runAfter: number
  modelId: string
  modelRevision: string
  modelSha256: string
  pipelineVersion: string
  dimensions: number
  windowMs: number
  overlapMs: number
  errorMessage: string | null
  startedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface VideoSceneRecord {
  id: string
  jobId: string
  assetId: string
  fileVersion: number
  seq: number
  startMs: number
  endMs: number
  thumbnailPath: string | null
  modelSha256: string
  pipelineVersion: string
  createdAt: number
}

/** One window's three vectors, as the worker computed them. */
export interface SceneVectorInput {
  seq: number
  startMs: number
  endMs: number
  thumbnailPath: string | null
  visual: Float32Array
  audio: Float32Array
  av: Float32Array
}

export interface SceneSearchHit {
  sceneId: string
  assetId: string
  seq: number
  startMs: number
  endMs: number
  thumbnailPath: string | null
  score: number
  modality: 'visual' | 'audio' | 'av'
}

export interface FaceJobRecord {
  id: string
  assetId: string
  fileVersion: number
  state: FaceJobState
  stage: FaceStage
  progress: number
  attempts: number
  maxAttempts: number
  leaseOwner: string | null
  leaseExpiresAt: number | null
  runAfter: number
  modelId: string
  modelRevision: string
  modelSha256: string
  pipelineVersion: string
  dimensions: number
  sampleMs: number
  errorMessage: string | null
  startedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface FaceDetectionRecord {
  id: string
  jobId: string
  assetId: string
  fileVersion: number
  frameMs: number
  x: number
  y: number
  width: number
  height: number
  score: number
  thumbnailPath: string | null
  modelSha256: string
  pipelineVersion: string
  createdAt: number
}

export interface FaceVectorInput {
  frameMs: number
  x: number
  y: number
  width: number
  height: number
  score: number
  thumbnailPath: string | null
  vector: Float32Array
}

export interface PersonRecord {
  id: string
  name: string
  state: PersonState
  coverDetectionId: string | null
  faceCount: number
  centroid: Float32Array | null
  dimensions: number | null
  modelSha256: string | null
  createdAt: number
  updatedAt: number
}

export interface PersonAssetRecord {
  personId: string
  assetId: string
  faceCount: number
  bestDetectionId: string | null
}
