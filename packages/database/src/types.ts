import type {
  AsrJobState,
  AsrStage,
  AssetKind,
  JobKind,
  JobState,
  ScanState,
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
