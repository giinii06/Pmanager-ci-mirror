export type AssetKind = 'image' | 'video'

export type JobKind = 'scan_library' | 'thumbnail' | 'preview' | 'hls'

export type JobState = 'queued' | 'running' | 'done' | 'failed'

export type ScanState = 'idle' | 'queued' | 'scanning'

export type PlaybackMode = 'direct' | 'hls' | 'none'

/** 0 runs first. */
export type Priority = 0 | 1 | 2 | 3 | 4

export interface UserDTO {
  id: string
  username: string
}

export interface LibraryDTO {
  id: string
  name: string
  rootPath: string
  createdAt: string
  lastScanAt: string | null
  scanState: ScanState
  scannedFiles: number
  assetCount: number
  folderCount: number
}

export interface FolderDTO {
  id: string
  libraryId: string
  parentId: string | null
  name: string
  relativePath: string
  depth: number
  assetCount: number
  /** Images in this folder only, so a collection card matches the gallery it opens. */
  directImageCount: number
  coverAssetId: string | null
}

export interface AssetDTO {
  id: string
  libraryId: string
  folderId: string | null
  kind: AssetKind
  filename: string
  relativePath: string
  mimeType: string
  sizeBytes: number
  width: number | null
  height: number | null
  durationMs: number | null
  takenAt: string
  favorite: boolean
  fileVersion: number
  playback: PlaybackMode
  thumbnails: {
    small: string
    medium: string
  }
  previewUrl: string
  streamUrl: string
  hlsUrl: string
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
  total: number
}

export interface JobDTO {
  id: number
  kind: JobKind
  state: JobState
  priority: number
  assetId: string | null
  libraryId: string | null
  attempts: number
  maxAttempts: number
  lastError: string | null
  updatedAt: string
}

export interface JobSummaryDTO {
  counts: Record<JobState, number>
  active: JobDTO[]
  recentFailures: JobDTO[]
}

export type AsrJobState =
  | 'queued'
  | 'transcribing'
  | 'aligning'
  | 'writing'
  | 'completed'
  | 'failed'
  | 'canceled'

export type AsrStage =
  | 'queued'
  | 'extracting'
  | 'chunking'
  | 'transcribing'
  | 'aligning'
  | 'writing'
  | 'completed'

export interface AsrJobDTO {
  id: string
  assetId: string
  fileVersion: number
  modelRevision: string
  alignerRevision: string
  pipelineVersion: string
  state: AsrJobState
  stage: AsrStage
  progress: number
  attempts: number
  maxAttempts: number
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export interface TranscriptSegmentDTO {
  seq: number
  startMs: number
  endMs: number
  text: string
}

export interface TranscriptDTO {
  id: string
  assetId: string
  fileVersion: number
  language: string
  plainText: string
  segments: TranscriptSegmentDTO[]
  createdAt: string
}

export interface TranscriptSummaryDTO {
  id: string
  language: string
  segmentCount: number
  createdAt: string
}

export interface TranscriptionStatusDTO {
  /** False when the server has no ASR worker configured. */
  available: boolean
  job: AsrJobDTO | null
  transcript: TranscriptSummaryDTO | null
}

export interface TranscriptSearchDTO {
  query: string
  hits: TranscriptSegmentDTO[]
}

export interface StatsDTO {
  assets: number
  images: number
  videos: number
  favorites: number
  libraries: number
  folders: number
}

export interface PlaybackProgressDTO {
  assetId: string
  positionMs: number
  durationMs: number
  updatedAt: string
}

export interface AuthStatusDTO {
  setupRequired: boolean
  authenticated: boolean
  user: UserDTO | null
}

export interface AssetQuery {
  libraryId?: string
  folderId?: string
  kind?: AssetKind
  favorite?: boolean
  q?: string
  cursor?: string | null
  limit?: number
}

export interface ApiErrorBody {
  error: string
  message: string
}
