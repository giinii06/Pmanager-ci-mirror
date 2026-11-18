export type AssetKind = 'image' | 'video'

export type JobKind = 'scan_library' | 'thumbnail' | 'preview' | 'hls' | 'process_archive'

export const VIDEO_SORTS = ['rate', 'views', 'latest', 'name', 'watch_time', 'votes'] as const
export type VideoSort = (typeof VIDEO_SORTS)[number]

export const FOLDER_SORTS = ['views', 'votes', 'name', 'date'] as const
export type FolderSort = (typeof FOLDER_SORTS)[number]

export type JobState = 'queued' | 'running' | 'paused' | 'cancelled' | 'done' | 'failed'

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

export interface TagDTO {
  id: string
  name: string
  createdAt: string
}

export interface TagSummaryDTO {
  id: string
  name: string
  assetCount: number
  coverAssetId: string | null
  coverPosterVersion: number | null
  createdAt: string
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
  coverWidth: number | null
  coverHeight: number | null
  coverPosterVersion: number
  viewCount: number
  voteCount: number
  rate: number | null
  createdAt: string
}

export interface AssetDTO {
  id: string
  libraryId: string
  folderId: string | null
  kind: AssetKind
  filename: string
  relativePath: string
  mimeType: string
  container: string | null
  videoCodec: string | null
  audioCodec: string | null
  sizeBytes: number
  width: number | null
  height: number | null
  durationMs: number | null
  takenAt: string
  viewCount: number
  watchTimeMs: number
  voteCount: number
  rate: number | null
  posterVersion: number
  tags: TagDTO[]
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
  workerId: string | null
  leaseEpoch: number
  leaseExpiresAt: string | null
  progressCurrent: number
  progressTotal: number | null
  phase: string | null
  pauseRequested: boolean
  cancelRequested: boolean
  completedAt: string | null
  lastError: string | null
  updatedAt: string
}

export interface JobSummaryDTO {
  counts: Record<JobState, number>
  active: JobDTO[]
  recentFailures: JobDTO[]
}

/** Media jobs run beside the GPU queue; ASR, translation and embedding share one card. */
export type WorkPipeline = 'media' | 'asr' | 'translation' | 'embedding'

export type WorkKind = JobKind | 'asr' | 'translation' | 'embedding'

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
  language: string | null
  hasSpeech: boolean
  plainText: string
  segments: TranscriptSegmentDTO[]
  createdAt: string
}

export interface TranscriptSummaryDTO {
  id: string
  /** Null when the file has no speech, because the language is then unknown. */
  language: string | null
  hasSpeech: boolean
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

export type EmbeddingJobState =
  | 'queued'
  | 'embedding'
  | 'writing'
  | 'completed'
  | 'failed'
  | 'canceled'

export type EmbeddingStage = 'queued' | 'starting' | 'embedding' | 'writing' | 'completed'

export type SceneJobState =
  | 'queued'
  | 'extracting'
  | 'embedding'
  | 'writing'
  | 'completed'
  | 'failed'
  | 'canceled'

export type SceneStage = 'queued' | 'extracting' | 'embedding' | 'writing' | 'completed'

/** Which part of a window matched. The player labels the hit with this. */
export type SceneModality = 'visual' | 'audio' | 'av'

export interface EmbeddingJobDTO {
  id: string
  assetId: string
  fileVersion: number
  state: EmbeddingJobState
  stage: EmbeddingStage
  progress: number
  attempts: number
  maxAttempts: number
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export interface SceneJobDTO {
  id: string
  assetId: string
  fileVersion: number
  state: SceneJobState
  stage: SceneStage
  progress: number
  attempts: number
  maxAttempts: number
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

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
  libraries: number
  folders: number
  totalViews: number
  totalWatchTimeMs: number
  totalVotes: number
  tags: number
}

export interface ActivityItemDTO {
  id: string
  kind: 'folder' | 'video'
  name: string
  relativePath: string
  assetId: string | null
  folderId: string | null
}

export interface ActivityDayDTO {
  date: string
  count: number
  level: 0 | 1 | 2 | 3 | 4
  items: ActivityItemDTO[]
}

export interface ActivityStatsDTO {
  days: ActivityDayDTO[]
  totalCount: number
  folderContributions: number
  videoContributions: number
  activeDays: number
  streakDays: number
}

export interface VoteActivityItemDTO {
  id: string
  targetType: 'asset' | 'folder'
  targetId: string
  title: string
  createdAt: string
}

export interface VoteActivityDayDTO {
  date: string
  count: number
  level: 0 | 1 | 2 | 3 | 4
  items: VoteActivityItemDTO[]
}

export interface VoteActivityStatsDTO {
  days: VoteActivityDayDTO[]
  totalVotes: number
  videoVotes: number
  folderVotes: number
  activeDays: number
  streakDays: number
}

export interface HostDriveDTO {
  id: string
  label: string
  rootPath: string
  totalBytes: number | null
  freeBytes: number | null
}

export interface HostFolderEntryDTO {
  name: string
  path: string
  hasChildren: boolean
  modifiedAt: string | null
}

export interface HostBrowseResponseDTO {
  currentPath: string
  parentPath: string | null
  breadcrumbs: Array<{ name: string; path: string }>
  folders: HostFolderEntryDTO[]
}

export interface BackupRecordDTO {
  id: string
  filename: string
  sizeBytes: number
  integrity: string
  createdAt: string
  error: string | null
}

export interface LibraryHealthDTO {
  id: string
  name: string
  rootPath: string
  status: 'available' | 'unavailable' | 'scanning' | 'blocked'
  scanState: ScanState
  lastError: string | null
  lastScanAt: string | null
  assetCount: number
  scannedFiles: number
}

export interface SystemStatusDTO {
  startedAt: string
  uptimeSeconds: number
  dbIntegrity: string
  sqliteVersion: string
  synchronousMode: string
  jobCounts: Record<JobState, number>
  activeWorkers: Array<{
    workerId: string
    jobId: number
    kind: JobKind
    phase: string | null
    progressCurrent: number
    progressTotal: number | null
    leaseExpiresAt: string | null
  }>
  libraries: LibraryHealthDTO[]
  lastRecovery: {
    workerId: string
    recoveredJobs: number
    cleanedTempFiles: number
    requeuedThumbnails: number
    dbIntegrity: string
    createdAt: string
  } | null
  lastBackup: BackupRecordDTO | null
}

export interface StorageStatsDTO {
  computedAt: string
  totalLibraryBytes: number
  videoBytes: number
  imageBytes: number
  thumbnailBytes: number
  cacheBytes: number
  tempBytes: number
  assetCount: number
  videoCount: number
  imageCount: number
}

export type ArchiveJobState =
  | 'queued'
  | 'extracting'
  | 'converting'
  | 'completed'
  | 'failed_password'
  | 'failed'

export interface ArchiveJobDTO {
  id: string
  libraryId: string
  archivePath: string
  state: ArchiveJobState
  passwordUsed: string | null
  extractedFiles: number
  convertedImages: number
  convertedVideos: number
  errorMessage: string | null
  createdAt: string
  updatedAt: string
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
  tagId?: string
  sort?: VideoSort
  seed?: number
  q?: string
  cursor?: string | null
  limit?: number
}

export interface ApiErrorBody {
  error: string
  message: string
}

export interface SceneDTO {
  id: string
  assetId: string
  seq: number
  startMs: number
  endMs: number
  thumbnailUrl: string | null
}

/** One result row of a semantic search, before the client groups it by asset. */
export interface SemanticHitDTO {
  kind: 'scene' | 'dialogue' | 'asset'
  assetId: string
  sceneId: string | null
  startMs: number | null
  endMs: number | null
  score: number
  source: SceneModality | 'dialogue' | 'title'
  text: string
  thumbnailUrl: string | null
  asset: {
    id: string
    filename: string
    kind: AssetKind
    durationMs: number | null
  }
}

export interface SemanticSearchDTO {
  query: string
  hits: SemanticHitDTO[]
  /** False when the scene index could not be reached, so only text ranked. */
  scenesSearched: boolean
}
