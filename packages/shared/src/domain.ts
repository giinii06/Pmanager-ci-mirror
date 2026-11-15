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

export interface ReviewDTO {
  id: string
  assetId: string
  rating: number
  body: string
  createdAt: string
  updatedAt: string
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

/** Media jobs run beside the GPU queue; ASR and translation share one card. */
export type WorkPipeline = 'media' | 'asr' | 'translation'

export type WorkKind = JobKind | 'asr' | 'translation'

/** Null means the number is not known yet, never zero. */
export type EtaBasis = 'history' | null

export interface WorkItemDTO {
  id: string
  pipeline: WorkPipeline
  kind: WorkKind
  assetId: string | null
  assetName: string | null
  state: 'running' | 'queued' | 'stalled' | 'failed'
  stage: string | null
  /** Null for media jobs, which report no progress. */
  progress: number | null
  /** Null for media jobs. False means the job is waiting for the card. */
  onGpu: boolean | null
  startedAt: string | null
  updatedAt: string | null
  etaSeconds: number | null
  errorMessage: string | null
}

export interface WorkPipelineDTO {
  pipeline: WorkPipeline
  /** Active rows with a live lease. Stalled rows are counted in `stalled` instead. */
  running: number
  queued: number
  stalled: number
  etaSeconds: number | null
  basis: EtaBasis
}

export interface WorkQueueDTO {
  generatedAt: string
  running: WorkItemDTO[]
  queued: WorkItemDTO[]
  stalled: WorkItemDTO[]
  remaining: number
  etaSeconds: number | null
  basis: EtaBasis
  pipelines: WorkPipelineDTO[]
  failures: WorkItemDTO[]
  lastCompletedAt: string | null
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

export type TranslationJobState =
  | 'queued'
  | 'translating'
  | 'writing'
  | 'completed'
  | 'failed'
  | 'canceled'

export type TranslationStage = 'queued' | 'starting' | 'translating' | 'writing' | 'completed'

export interface TranslationJobDTO {
  id: string
  assetId: string
  fileVersion: number
  sourceLanguage: string
  targetLanguage: string
  state: TranslationJobState
  stage: TranslationStage
  progress: number
  attempts: number
  maxAttempts: number
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export interface TranslationSegmentDTO {
  seq: number
  startMs: number
  endMs: number
  text: string
}

export interface TranslationDTO {
  id: string
  assetId: string
  fileVersion: number
  sourceLanguage: string
  targetLanguage: string
  plainText: string
  segments: TranslationSegmentDTO[]
  createdAt: string
}

export interface TranslationSummaryDTO {
  id: string
  sourceLanguage: string
  targetLanguage: string
  segmentCount: number
  createdAt: string
}

export interface TranslationStatusDTO {
  /** False when the server has no translation worker configured. */
  available: boolean
  job: TranslationJobDTO | null
  translation: TranslationSummaryDTO | null
}

/**
 * `language` is the tag the client asks for. `original` resolves to whatever
 * the ASR produced, so a Korean source needs no translation job at all.
 */
export interface SubtitleTrackDTO {
  language: string
  source: 'asr' | 'translation'
  ready: boolean
}

export interface SubtitleTracksDTO {
  tracks: SubtitleTrackDTO[]
  defaultLanguage: string | null
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
