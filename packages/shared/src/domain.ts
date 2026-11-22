import type { AiStage, FilterTree } from './filters'

export type AssetKind = 'image' | 'video'

export type JobKind = 'scan_library' | 'thumbnail' | 'preview' | 'hls' | 'process_archive' | 'maintenance'

export const VIDEO_SORTS = ['rate', 'random', 'views', 'latest', 'name', 'watch_time', 'votes'] as const
export type VideoSort = (typeof VIDEO_SORTS)[number]

export const FOLDER_SORTS = ['random', 'views', 'votes', 'name', 'date'] as const
export type FolderSort = (typeof FOLDER_SORTS)[number]

export type JobState = 'queued' | 'running' | 'paused' | 'cancelled' | 'done' | 'failed'

export type ScanState = 'idle' | 'queued' | 'scanning'

export const LIBRARY_HEALTH_STATES = ['ONLINE', 'DEGRADED', 'OFFLINE', 'UNVERIFIED'] as const
export type LibraryHealthState = (typeof LIBRARY_HEALTH_STATES)[number]

export type PlaybackMode = 'direct' | 'hls' | 'none'



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
