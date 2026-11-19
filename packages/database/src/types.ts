import type {
  ArchiveJobState,
  AsrJobState,
  AsrStage,
  AssetKind,
  EmbeddingJobState,
  EmbeddingStage,
  JobKind,
  JobState,
  ScanState,
  SceneJobState,
  SceneStage,
  TagDTO,
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
  coverWidth: number | null
  coverHeight: number | null
  coverPosterVersion: number
  coverFileVersion: number
  viewCount: number
  voteCount: number
  rate: number | null
  createdAt: number
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
  viewCount: number
  watchTimeMs: number
  voteCount: number
  posterVersion: number
}

export interface AssetRecord extends AssetRow {
  rate: number | null
  tags: TagDTO[]
}

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

export type FileMutationKind = 'delete' | 'move' | 'copy' | 'extract'

export type FileMutationState =
  | 'requested'
  | 'validated'
  | 'quarantined'
  | 'db_committed'
  | 'purging'
  | 'completed'
  | 'failed_retryable'
  | 'blocked'
  | 'cancelled_pre_commit'

export interface FileMutationRecord {
  id: string
  kind: FileMutationKind
  assetId: string | null
  libraryId: string | null
  userId: string | null
  requestKey: string
  requestedFileVersion: number | null
  originalDeletedAt: number | null
  state: FileMutationState
  resumeState: FileMutationState | null
  sourceRel: string | null
  quarantineRel: string | null
  quarantineRoot: string | null
  manifestJson: string | null
  attempts: number
  maxAttempts: number
  retryAfter: number
  leaseOwner: string | null
  leaseEpoch: number
  leaseExpiresAt: number | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface MutationEventRecord {
  id: number
  mutationId: string
  state: string
  payloadRedacted: string | null
  createdAt: number
}

export interface MutationAssetRow {
  id: string
  libraryId: string
  relativePath: string
  filename: string
  fileVersion: number
  sizeBytes: number
  mtimeMs: number
  deletedAt: number | null
  pendingDeleteMutationId: string | null
  libraryRoot: string
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
  workerId: string | null
  leaseEpoch: number
  leaseExpiresAt: number | null
  progressCurrent: number
  progressTotal: number | null
  phase: string | null
  checkpoint: string | null
  pauseRequested: 0 | 1
  cancelRequested: 0 | 1
  lastError: string | null
  startedAt: number | null
  completedAt: number | null
  updatedAt: number
}

export type LibraryHealthState = 'ONLINE' | 'DEGRADED' | 'OFFLINE' | 'UNVERIFIED'

export interface LibraryHealthRecord {
  libraryId: string
  state: LibraryHealthState
  rootIdentity: string | null
  lastSuccessAt: number | null
  lastErrorCode: string | null
  checkedAt: number
  consecutiveFailures: number
}

export interface ScanRunRecord {
  id: string
  libraryId: string
  rootPath: string
  phase: string
  status: string
  resumedFromRunId: string | null
  filesSeen: number
  filesAdded: number
  filesUpdated: number
  filesSkipped: number
  filesRemoved: number
  readErrors: number
  errorMessage: string | null
  mountIdentity: string | null
  missingCount: number
  missingRatio: number
  authoritativeVerified: number
  healthState: LibraryHealthState | null
  startedAt: number
  updatedAt: number
  completedAt: number | null
}

export interface ScanCheckpointRecord {
  libraryId: string
  scanId: string
  startedAt: number
  lastDirRel: string
  lastRelPath: string
  processedFiles: number
  totalEstimate: number | null
  updatedAt: number
}

export interface VoteEventRecord {
  id: string
  targetType: 'asset' | 'folder'
  targetId: string
  title: string
  dayKey: string
  createdAt: number
}

export interface RecoveryLogRecord {
  id: number
  workerId: string
  recoveredJobs: number
  cleanedTempFiles: number
  requeuedThumbnails: number
  dbIntegrity: string
  createdAt: number
}

export interface BackupLogRecord {
  id: string
  filename: string
  sizeBytes: number
  integrity: string
  createdAt: number
  error: string | null
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
  fileVersion: number | null
  progressVersion: number
  lastSessionId: string | null
  lastSeq: number
  updatedAt: number
}

export interface PlaySessionRecord {
  id: string
  userId: string
  assetId: string
  fileVersion: number
  clientSessionKey: string
  startedAt: number
  endedAt: number | null
  viewRecordedAt: number | null
  lastSeq: number
}

export type PlayEventType = 'watch_time' | 'progress' | 'view'

export interface PlayEventRecord {
  eventId: string
  sessionId: string
  seq: number
  type: PlayEventType
  deltaMs: number | null
  positionMs: number | null
  durationMs: number | null
  clientTimestamp: number | null
  recordedAt: number
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
  /** 0 when the file carries no speech, which leaves the language meaningless. */
  hasSpeech: 0 | 1
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

export interface TagRecord {
  id: string
  name: string
  createdAt: number
}

export interface TagSummaryRecord {
  id: string
  name: string
  assetCount: number
  coverAssetId: string | null
  coverPosterVersion: number | null
  createdAt: number
}

export interface ContributionEventRecord {
  id: string
  entityType: 'folder' | 'video'
  entityKey: string
  assetId: string | null
  folderId: string | null
  title: string
  relativePath: string
  dayKey: string
  occurredAt: number
}

export interface ArchiveJobRecord {
  id: string
  libraryId: string
  archivePath: string
  state: ArchiveJobState
  passwordUsed: string | null
  extractedFiles: number
  convertedImages: number
  convertedVideos: number
  errorMessage: string | null
  signature: string
  createdAt: number
  updatedAt: number
}

export type HlsGenerationState =
  | 'queued'
  | 'running'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'retry_wait'
  | 'deleting'
  | 'removed'

export interface HlsGenerationRecord {
  id: string
  assetId: string
  fileVersion: number
  profileHash: string
  state: HlsGenerationState
  stage: string | null
  progress: number
  storageRel: string | null
  playlistRel: string | null
  jobId: number | null
  workerId: string | null
  leaseEpoch: number
  requestSeq: number
  encoder: string | null
  createdAt: number
  updatedAt: number
  publishedAt: number | null
  supersededAt: number | null
  eligibleForGcAt: number | null
  lastAccessAt: number | null
  errorCode: string | null
  errorMessage: string | null
}

export interface HlsActiveRecord {
  assetId: string
  fileVersion: number
  profileHash: string
  generationId: string
  requestSeq: number
  updatedAt: number
}

export interface UserSessionRecord {
  id: string
  userId: string
  userAgent: string | null
  createdAt: number
  lastSeenAt: number
  expiresAt: number
  revokedAt: number | null
}
