import type { AiStage, FilterTree } from './filters'

export type AssetKind = 'image' | 'video'

export type JobKind = 'scan_library' | 'thumbnail' | 'preview' | 'hls' | 'process_archive' | 'maintenance'

export const VIDEO_SORTS = ['rate', 'views', 'latest', 'name', 'watch_time', 'votes'] as const
export type VideoSort = (typeof VIDEO_SORTS)[number]

export const FOLDER_SORTS = ['views', 'votes', 'name', 'date'] as const
export type FolderSort = (typeof FOLDER_SORTS)[number]

export type JobState = 'queued' | 'running' | 'paused' | 'cancelled' | 'done' | 'failed'

export type ScanState = 'idle' | 'queued' | 'scanning'

export const LIBRARY_HEALTH_STATES = ['ONLINE', 'DEGRADED', 'OFFLINE', 'UNVERIFIED'] as const
export type LibraryHealthState = (typeof LIBRARY_HEALTH_STATES)[number]

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
  healthState: LibraryHealthState
  healthErrorCode: string | null
  healthCheckedAt: string | null
  healthConsecutiveFailures: number
}

export interface ScanRunDTO {
  id: string
  phase: string
  status: string
  filesSeen: number
  filesAdded: number
  filesUpdated: number
  filesSkipped: number
  filesRemoved: number
  readErrors: number
  missingCount: number
  missingRatio: number
  authoritativeVerified: boolean
  healthState: LibraryHealthState | null
  errorMessage: string | null
  startedAt: string
  completedAt: string | null
}

export interface LibraryHealthDetailDTO {
  libraryId: string
  state: LibraryHealthState
  rootIdentity: string | null
  lastSuccessAt: string | null
  lastErrorCode: string | null
  checkedAt: string | null
  consecutiveFailures: number
  scan: ScanRunDTO | null
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

/** A personal diary page; createdAt is immutable and fixed by the server at creation. */
export interface JournalEntryDTO {
  id: string
  title: string
  body: string
  createdAt: string
  updatedAt: string
}

export type JournalEntrySummaryDTO = Omit<JournalEntryDTO, 'body'>

export interface JournalMentionDTO {
  type: 'video' | 'album'
  id: string
  label: string
  libraryName: string
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
  coverFileVersion: number
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
  hlsStatusUrl: string
}

export type HlsStatusState =
  | 'queued'
  | 'running'
  | 'ready'
  | 'failed'
  | 'retry_wait'
  | 'cancelled'
  | 'source_offline'

/** The player's view of an HLS generation request. */
export interface HlsStatusDTO {
  state: HlsStatusState
  generationId?: string
  jobId?: number | null
  stage?: string | null
  progressPercent?: number
  retryAfterSeconds?: number
  errorCode?: string | null
  message?: string | null
  playlistUrl?: string
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
  /** The API request that enqueued this job, so a support report can trace it. */
  requestId?: string | null
  updatedAt: string
}

export interface JobSummaryDTO {
  counts: Record<JobState, number>
  active: JobDTO[]
  recentFailures: JobDTO[]
}

/** Media jobs run beside the GPU queue; ASR, translation and embedding share one card. */
export type WorkPipeline =
  | 'media'
  | 'asr'
  | 'translation'
  | 'embedding'
  | 'scene'
  | 'backup'
  | 'maintenance'
  | 'mutation'
  | 'bulk'

export type WorkKind =
  | JobKind
  | 'asr'
  | 'translation'
  | 'embedding'
  | 'scene'
  | 'backup'
  | 'maintenance'
  | 'mutation'
  | 'bulk'

/** Null means the number is not known yet, never zero. */
export type EtaBasis = 'history' | 'insufficient_data' | null

/**
 * Stable failure classes shared by the worker, the API and the panel. The code
 * is stored as a `[CODE] ` prefix in the existing error columns, so an older row
 * without a prefix keeps its message and reports no code.
 */
export const JOB_ERROR_CODES = [
  'SOURCE_OFFLINE',
  'SOURCE_NOT_FOUND_CONFIRMED',
  'SOURCE_CHANGED',
  'FILE_CORRUPT',
  'PERMISSION_DENIED',
  'DISK_FULL',
  'GPU_OOM',
  'GPU_LEASE_LOST',
  'MODEL_MISSING',
  'MODEL_SHA_MISMATCH',
  'PROCESS_TIMEOUT',
  'PROTOCOL_MISMATCH',
  'USER_CANCELLED',
  'INTERNAL',
] as const

export type JobErrorCode = (typeof JOB_ERROR_CODES)[number]

const JOB_ERROR_PREFIX = /^\[([A-Z_]+)\]\s*/

export function formatJobError(code: JobErrorCode, message: string): string {
  return `[${code}] ${message}`
}

export function parseJobError(text: string | null | undefined): {
  code: JobErrorCode | null
  message: string | null
} {
  if (!text) return { code: null, message: null }
  const match = JOB_ERROR_PREFIX.exec(text)
  if (!match) return { code: null, message: text }
  const code = match[1] as JobErrorCode
  if (!JOB_ERROR_CODES.includes(code)) return { code: null, message: text }
  return { code, message: text.slice(match[0].length) }
}

/** These failures wait for the environment instead of burning retry attempts. */
export function isEnvironmentJobError(code: JobErrorCode | null): boolean {
  return code === 'SOURCE_OFFLINE' || code === 'DISK_FULL'
}

/** How much of a file the scene index actually analyses. */
export interface SceneCoverage {
  /** Windows this job plans to analyse. */
  analyzed: number
  /** Windows a full pass without `SCENE_MAX_WINDOWS` would analyse. */
  total: number
  /** True when the cap turned a full pass into a sample. */
  sampled: boolean
}

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
  /** True while a running GPU job has not taken the card yet. */
  waitingGpu: boolean
  /** Scene sampling against a full-coverage plan; null for every other lane. */
  coverage: SceneCoverage | null
  startedAt: string | null
  updatedAt: string | null
  etaSeconds: number | null
  errorCode: string | null
  errorMessage: string | null
}

export interface WorkPipelineDTO {
  pipeline: WorkPipeline
  /** Active rows with a live lease. Stalled rows are counted in `stalled` instead. */
  running: number
  queued: number
  stalled: number
  /** Active GPU rows that hold the card, and those still waiting for it. */
  runningGpu: number
  waitingGpu: number
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
  /** Null only for a row written before file versions were tracked. */
  fileVersion: number | null
  progressVersion: number
  updatedAt: string
}

export interface PlaySessionDTO {
  sessionId: string
  assetId: string
  fileVersion: number
  issuedAt: string
}

export type PlayEventType = 'watch_time' | 'progress' | 'view'

export interface PlayEventResultDTO {
  applied: boolean
  duplicate: boolean
  viewCount: number
  watchTimeMs: number
  progress: PlaybackProgressDTO | null
  lastSeq: number
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
  /** Serves a saved filter's membership alongside any of the filters above. */
  albumId?: string
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

export type FileOperationState =
  | 'requested'
  | 'validated'
  | 'quarantined'
  | 'db_committed'
  | 'purging'
  | 'completed'
  | 'failed_retryable'
  | 'blocked'
  | 'cancelled_pre_commit'

/** A durable delete or move request. The client polls until it reaches a terminal state. */
export interface FileOperationDTO {
  id: string
  kind: 'delete' | 'move' | 'copy' | 'extract'
  assetId: string | null
  state: FileOperationState
  errorCode: string | null
  attempts: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
  statusUrl: string
}

export type DuplicateGroupKind = 'exact' | 'similar'

export type DuplicateGroupState = 'open' | 'ignored' | 'kept'

/**
 * One file inside a duplicate group. `sameInode` marks a member that shares a
 * body of bytes with another member through a hardlink, so deleting it would
 * delete both.
 */
export interface DuplicateGroupMemberDTO {
  assetId: string
  filename: string
  kind: string
  sizeBytes: number
  width: number | null
  height: number | null
  durationMs: number | null
  takenAt: string
  libraryName: string
  rootPath: string
  relativePath: string
  fileVersion: number
  confidence: number
  sameInode: boolean
  thumbnailUrl: string
}

/** A group of files with identical bytes. It is review material, never a delete order. */
export interface DuplicateGroupDTO {
  id: string
  kind: DuplicateGroupKind
  fingerprint: string
  state: DuplicateGroupState
  createdAt: string
  updatedAt: string
  memberCount: number
  totalBytes: number
  members: DuplicateGroupMemberDTO[]
}

export interface DuplicateGroupListDTO {
  groups: DuplicateGroupDTO[]
  nextCursor: string | null
}

/**
 * A stored filter as it is served. `valid: false` means the album's JSON no
 * longer parses against the current field registry, so its asset list is
 * refused rather than answered with a broad match.
 */
export type SmartAlbumFilter =
  | { valid: true; tree: FilterTree }
  | { valid: false; error: string }

/** A saved filter. It moves no file and copies no row; only the condition is stored. */
export interface SmartAlbumDTO {
  id: string
  name: string
  description: string | null
  filter: SmartAlbumFilter
  sort: VideoSort | null
  pinned: boolean
  createdAt: string
  updatedAt: string
}

export type SmartAlbumPage = Page<AssetDTO> & { album: SmartAlbumDTO }

/**
 * `watch_later` is the one list every user gets without asking for it. It is a
 * kind rather than a flag so a caller must handle the default list explicitly,
 * and the database holds at most one per user.
 */
export type PlaylistKind = 'custom' | 'watch_later'

/** A named, ordered list of assets. It references them; it copies nothing. */
export interface PlaylistDTO {
  id: string
  name: string
  description: string | null
  kind: PlaylistKind
  itemCount: number
  /** Items whose asset still exists. The rest render as broken links. */
  availableCount: number
  createdAt: string
  updatedAt: string
}

/**
 * One slot in a playlist. `available: false` means the asset was soft-deleted;
 * the row stays so the user decides when to clear the broken link.
 */
export interface PlaylistItemDTO {
  id: string
  assetId: string
  position: number
  addedAt: string
  available: boolean
}

export interface PlaylistDetailDTO {
  playlist: PlaylistDTO
  items: PlaylistItemDTO[]
}

export interface PlaylistAssetsDTO {
  playlist: PlaylistDTO
  items: AssetDTO[]
}

/**
 * A mark at a timestamp. `fileVersion` records the file it was made against, so
 * `stale` is a comparison at read time rather than a flag every scan rewrites.
 */
export interface VideoBookmarkDTO {
  id: string
  assetId: string
  positionMs: number
  title: string | null
  note: string | null
  fileVersion: number
  stale: boolean
  createdAt: string
  updatedAt: string
}

/** The kinds a bulk operation can run. A vote is deliberately not one of them. */
export type BulkOperationKind =
  | 'tag_add'
  | 'tag_remove'
  | 'reanalyze'
  | 'poster'
  | 'move'
  | 'copy'
  | 'delete'
  | 'export'

export type BulkOperationState =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'

export type BulkItemState = 'pending' | 'running' | 'succeeded' | 'failed' | 'held' | 'cancelled'

/**
 * The frozen target set. `ids` is what the user picked; `query` is the gallery
 * filter resolved once at preview and again at create, so "all results" cannot
 * grow between the confirmation and the first item.
 */
export type BulkSelection =
  | { kind: 'ids'; assetIds: string[] }
  | { kind: 'query'; query: AssetQuery }

export interface BulkOperationParams {
  tagId?: string
  targetLibraryId?: string
  targetFolder?: string
  stages?: AiStage[]
  /** Required for delete; the server refuses a delete without it. */
  confirm?: 'delete'
}

export interface BulkPreviewSample {
  assetId: string
  filename: string
  relativePath: string
  libraryId: string
}

export interface BulkPreviewProblem {
  code: string
  count: number
  message: string
}

/** What a dry run reports before anything is written. */
export interface BulkPreviewDTO {
  kind: BulkOperationKind
  selectionKind: 'ids' | 'query'
  count: number
  totalBytes: number
  sample: BulkPreviewSample[]
  problems: BulkPreviewProblem[]
  availability: { delete: boolean; move: boolean; copy: boolean }
  /** Passed back to create; a mismatch means the result set moved. */
  generation: string
}

export interface BulkOperationCountsDTO {
  total: number
  pending: number
  running: number
  succeeded: number
  failed: number
  held: number
  cancelled: number
}

export interface BulkErrorGroupDTO {
  code: string
  message: string
  count: number
}

export interface BulkOperationDTO {
  id: string
  kind: BulkOperationKind
  state: BulkOperationState
  selectionKind: 'ids' | 'query'
  snapshotCount: number
  counts: BulkOperationCountsDTO
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  statusUrl: string
  exportUrl: string | null
}

export interface BulkOperationItemDTO {
  id: string
  assetId: string
  position: number
  filename: string
  relativePath: string
  sizeBytes: number
  state: BulkItemState
  errorCode: string | null
  errorMessage: string | null
  attempts: number
  updatedAt: string
}

export interface BulkOperationDetailDTO extends BulkOperationDTO {
  errorGroups: BulkErrorGroupDTO[]
  items: BulkOperationItemDTO[]
}

export interface BulkOperationListDTO {
  operations: BulkOperationDTO[]
}

export const NOTIFICATION_KINDS = [
  'drive_offline',
  'mass_missing',
  'disk_low',
  'gpu_oom',
  'job_stalled',
  'backup_missing',
  'backup_failed',
  'db_integrity',
  'restart_loop',
  'mutation_failed',
] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

export const NOTIFICATION_SEVERITIES = ['info', 'warning', 'critical'] as const
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number]

export const NOTIFICATION_STATES = ['open', 'resolved', 'dismissed'] as const
export type NotificationState = (typeof NOTIFICATION_STATES)[number]

/** One incident. `metadata` carries the ids the worker saw, never a secret. */
export interface NotificationDTO {
  id: string
  kind: NotificationKind
  severity: NotificationSeverity
  state: NotificationState
  title: string
  body: string
  metadata: unknown
  occurrences: number
  readAt: string | null
  firstSeenAt: string
  lastSeenAt: string
  lastNotifiedAt: string | null
  resolvedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface NotificationListDTO {
  notifications: NotificationDTO[]
  nextCursor: string | null
}

export interface NotificationUnreadDTO {
  unread: number
  open: number
}

export interface DeliveryAttemptDTO {
  id: string
  notificationId: string
  channel: 'discord'
  messageKind: 'alert' | 'recovery'
  status: 'pending' | 'sent' | 'failed'
  attempts: number
  nextAttemptAt: string
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export interface WorkerHeartbeatDTO {
  instanceId: string
  workerId: string
  component: string
  pid: number
  state: 'idle' | 'running' | 'stopping'
  currentJobId: number | null
  startedAt: string
  lastSeenAt: string
}

export interface GpuLeaseHealthDTO {
  resourceId: string
  owner: string
  taskKind: string
  leaseExpiresAt: string
  updatedAt: string
  expired: boolean
}

/** `stale` means the capacity read failed; the numbers are unknown, not zero. */
export interface VolumeHealthDTO {
  label: string
  totalBytes: number | null
  freeBytes: number | null
  freeRatio: number | null
  stale: boolean
}

export interface StorageCategoryDTO {
  type: string
  bytes: number
  files: number
}

export const CACHE_TYPES = [
  'thumbs',
  'previews',
  'hls',
  'scenes',
  'scene_checkpoints',
  'temp',
  'exports',
] as const
export type CacheType = (typeof CACHE_TYPES)[number]

export interface CacheTypeDTO {
  type: CacheType
  bytes: number
  files: number
  oldestAt: string | null
  newestAt: string | null
  /** Safe to delete and rebuild from the original. */
  regenerable: boolean
  /** Never a cleanup candidate at all. */
  protected: boolean
}

export interface CacheInventoryDTO {
  computedAt: string
  totalBytes: number
  types: CacheTypeDTO[]
}

export interface CacheCleanupPreviewDTO {
  generation: string
  cutoff: string
  types: CacheType[]
  files: number
  bytes: number
  protectedBytes: number
  /** What the operator pays to get the deleted data back. */
  restoreCost: string
}

export interface CacheCleanupResultDTO {
  deletedFiles: number
  deletedBytes: number
  failed: number
}

/** One attempt at making a search index the one search reads. */
export interface SearchIndexBuildDTO {
  id: string
  kind: 'fts' | 'faiss'
  state: 'building' | 'ready' | 'superseded' | 'failed'
  source: 'bootstrap' | 'operator' | 'boot-repair'
  assets: number
  segments: number
  /** Highest content rowid the build covered, per corpus. */
  assetWatermark: number
  segmentWatermark: number
  modelSha256: string | null
  pipelineVersion: string | null
  dimensions: number | null
  startedAt: string
  finishedAt: string | null
  verifiedAt: string | null
  supersededAt: string | null
  lastError: string | null
}

export interface SearchIndexStatusDTO {
  kind: 'fts'
  active: SearchIndexBuildDTO | null
  /** How this API process's boot left the index. */
  mode: 'adopted' | 'bootstrapped' | 'repaired' | 'off' | null
  /** This API process verified the index on its own handle. */
  processReady: boolean
  triggersArmed: boolean
  /** Both corpora are still FTS5 tables. */
  intact: boolean
  /** Which path a query takes right now, not why it is in that state. */
  fallback: 'fts' | 'like-fallback' | 'unavailable'
  live: {
    assets: number
    segments: number
    assetWatermark: number
    segmentWatermark: number
  } | null
  /** Content rows written since the active build, from the watermarks. */
  rowsSinceBuild: { assets: number; segments: number } | null
  /** Process-local: the last time this handle's fast path threw. */
  lastQueryFailure: { at: string; message: string } | null
  recent: SearchIndexBuildDTO[]
}

export interface SearchIndexGcPreviewDTO {
  builds: SearchIndexBuildDTO[]
  total: number
}

export interface DiagnosticsAppSectionDTO {
  version: string
  startedAt: string
  uptimeSeconds: number
  pid: number
  bunVersion: string
}

export interface DiagnosticsDatabaseSectionDTO {
  schemaVersion: number
  integrity: string
  sqliteVersion: string
  synchronousMode: string
  journalMode: string
  dbBytes: number
  walBytes: number
  pageCount: number
  freelistCount: number
  busyTimeoutMs: number
}

export interface DiagnosticsWorkerSectionDTO {
  heartbeats: WorkerHeartbeatDTO[]
  activeLeases: Array<{
    workerId: string
    jobId: number
    kind: JobKind
    phase: string | null
    progressCurrent: number
    progressTotal: number | null
    leaseExpiresAt: string | null
  }>
  gpuLeases: GpuLeaseHealthDTO[]
  recentFailures: JobDTO[]
}

export interface DiagnosticsQueueSectionDTO {
  counts: Record<JobState, number>
  pipelines: WorkPipelineDTO[]
  stalled: number
  remaining: number
}

export interface DiagnosticsBackupSectionDTO {
  latest: BackupRecordDTO | null
  lastSuccessAt: string | null
  lastSuccessAgeHours: number | null
  count: number
  totalBytes: number
  externalCopy: 'unknown'
}

export interface DiagnosticsStorageSectionDTO {
  volumes: VolumeHealthDTO[]
  categories: StorageCategoryDTO[]
}

export interface DiagnosticsNotificationSectionDTO {
  open: number
  unread: number
  last24h: number
}

export interface DiagnosticsFlagsDTO {
  fileMutation: boolean
  hlsGenerations: boolean
  bulkOperations: boolean
  notifications: boolean
  searchFts: boolean
}

export interface DiagnosticsReportDTO {
  generatedAt: string
  app: DiagnosticsAppSectionDTO
  database: DiagnosticsDatabaseSectionDTO
  libraries: LibraryHealthDTO[]
  workers: DiagnosticsWorkerSectionDTO
  queues: DiagnosticsQueueSectionDTO
  backups: DiagnosticsBackupSectionDTO
  storage: DiagnosticsStorageSectionDTO
  caches: CacheInventoryDTO
  searchIndex: SearchIndexStatusDTO
  notifications: DiagnosticsNotificationSectionDTO
  flags: DiagnosticsFlagsDTO
}

export interface CapabilitiesDTO {
  fileMutation: boolean
  hlsGenerations: boolean
  bulkOperations: boolean
  notifications: boolean
  searchFts: boolean
  smartAlbums: boolean
  version: string
  schemaVersion: number
}

export interface RequestMetricDTO {
  method: string
  route: string
  count: number
  errors: number
  clientErrors: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}

export interface SystemMetricsDTO {
  since: string
  generatedAt: string
  requests: RequestMetricDTO[]
  database: {
    walBytes: number
    dbBytes: number
    pageCount: number
    freelistCount: number
  }
  queues: Record<JobState, number>
  process: {
    rssBytes: number
    heapUsedBytes: number
    uptimeSeconds: number
  }
}
