import type {
  ActivityStatsDTO,
  ArchiveJobDTO,
  AssetDTO,
  DuplicateGroupDTO,
  DuplicateGroupListDTO,
  AssetQuery,
  AuthStatusDTO,
  BackupRecordDTO,
  CacheCleanupPreviewDTO,
  CacheCleanupResultDTO,
  CacheInventoryDTO,
  CapabilitiesDTO,
  DiagnosticsReportDTO,
  FolderDTO,
  FolderSort,
  FileOperationDTO,
  HostBrowseResponseDTO,
  HostDriveDTO,
  HlsStatusDTO,
  JobDTO,
  JournalEntryDTO,
  JournalEntryPageDTO,
  JournalMentionDTO,
  JobSummaryDTO,
  LibraryDTO,
  LibraryHealthDetailDTO,
  NotificationDTO,
  NotificationListDTO,
  NotificationUnreadDTO,
  Page,
  PlayEventResultDTO,
  PlayEventType,
  PlaySessionDTO,
  SearchIndexBuildDTO,
  SearchIndexGcPreviewDTO,
  SearchIndexStatusDTO,
  ReviewDTO,
  StatsDTO,
  StorageStatsDTO,
  SubtitleTracksDTO,
  SystemMetricsDTO,
  SystemStatusDTO,
  TagDTO,
  TagSummaryDTO,
  TranscriptDTO,
  TranscriptSearchDTO,
  TranscriptionStatusDTO,
  TranslationDTO,
  TranslationJobDTO,
  TranslationStatusDTO,
  TranslationSummaryDTO,
  UserDTO,
  VideoBookmarkDTO,
  VoteActivityStatsDTO,
  WorkQueueDTO,
} from '@mediavault/shared'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly requestId?: string,
    readonly diagnosticId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })

  if (!response.ok) {
    let message = `요청이 실패했습니다 (${response.status})`
    let code: string | undefined
    let requestId: string | undefined
    let diagnosticId: string | undefined
    try {
      const body = (await response.json()) as {
        message?: string
        error?: string
        requestId?: string
        diagnosticId?: string
      }
      if (body?.message) message = body.message
      if (body?.error) code = body.error
      if (body?.requestId) requestId = body.requestId
      if (body?.diagnosticId) diagnosticId = body.diagnosticId
    } catch {
      // Keep the status message.
    }
    // The short id is what an operator can grep; the full id stays on the error.
    if (diagnosticId) message = `${message} (진단 ID: ${diagnosticId})`
    throw new ApiError(response.status, message, code, requestId, diagnosticId)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

function queryString(query: AssetQuery): string {
  const params = new URLSearchParams()
  if (query.libraryId) params.set('libraryId', query.libraryId)
  if (query.folderId) params.set('folderId', query.folderId)
  if (query.kind) params.set('kind', query.kind)
  if (query.tagId) params.set('tagId', query.tagId)
  if (query.sort) params.set('sort', query.sort)
  if (query.seed !== undefined) params.set('seed', String(query.seed))
  if (query.q) params.set('q', query.q)
  if (query.cursor) params.set('cursor', query.cursor)
  if (query.limit) params.set('limit', String(query.limit))
  const text = params.toString()
  return text ? `?${text}` : ''
}

function withLang(path: string, lang: string | undefined): string {
  if (!lang) return path
  return `${path}${path.includes('?') ? '&' : '?'}lang=${encodeURIComponent(lang)}`
}

export interface FolderDetail {
  folder: FolderDTO
  breadcrumb: FolderDTO[]
}

export const api = {
  status: () => request<AuthStatusDTO>('/api/auth/status'),
  setup: (username: string, password: string) =>
    request<{ user: UserDTO }>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  login: (username: string, password: string) =>
    request<{ user: UserDTO }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),

  libraries: () => request<LibraryDTO[]>('/api/libraries'),
  createLibrary: (name: string, rootPath: string) =>
    request<LibraryDTO>('/api/libraries', {
      method: 'POST',
      body: JSON.stringify({ name, rootPath }),
    }),
  scanLibrary: (id: string) => request<{ ok: boolean }>(`/api/libraries/${id}/scan`, { method: 'POST' }),
  verifyLibrary: (id: string) =>
    request<LibraryHealthDetailDTO>(`/api/libraries/${id}/verify`, { method: 'POST' }),
  deleteLibrary: (id: string) => request<void>(`/api/libraries/${id}`, { method: 'DELETE' }),

  folders: (opts?: { libraryId?: string; sort?: FolderSort }) => {
    const params = new URLSearchParams()
    if (opts?.libraryId) params.set('libraryId', opts.libraryId)
    if (opts?.sort) params.set('sort', opts.sort)
    const qs = params.toString()
    return request<FolderDTO[]>(`/api/folders${qs ? `?${qs}` : ''}`)
  },
  folder: (id: string) => request<FolderDetail>(`/api/folders/${id}`),
  deleteAlbum: (id: string, requestKey: string) =>
    request<{ id: string; folderId: string; total: number; completed: number; failed: number; pending: number; state: 'pending' | 'completed' | 'failed' }>(
      `/api/folders/${encodeURIComponent(id)}/delete-operations`,
      { method: 'POST', headers: { 'Idempotency-Key': requestKey } },
    ),
  albumDeleteStatus: (id: string) =>
    request<{ id: string; folderId: string; total: number; completed: number; failed: number; pending: number; state: 'pending' | 'completed' | 'failed' }>(
      `/api/album-delete-batches/${encodeURIComponent(id)}`,
    ),
  voteFolder: (id: string, clientRequestId?: string) =>
    request<FolderDTO>(`/api/folders/${id}/vote`, {
      method: 'POST',
      body: clientRequestId ? JSON.stringify({ clientRequestId }) : undefined,
    }),
  setFolderCover: (id: string, assetId: string) =>
    request<FolderDTO>(`/api/folders/${encodeURIComponent(id)}/cover`, {
      method: 'PUT',
      body: JSON.stringify({ assetId }),
    }),

  assets: (query: AssetQuery) => request<Page<AssetDTO>>(`/api/assets${queryString(query)}`),
  assetIds: (query: AssetQuery) => request<{ ids: string[] }>(`/api/assets/ids${queryString(query)}`),
  asset: (id: string) => request<AssetDTO>(`/api/assets/${id}`),
  neighbor: (
    id: string,
    query: AssetQuery,
    direction: 'next' | 'prev',
    signal?: AbortSignal,
  ) => {
    const qs = queryString(query)
    return request<{ asset: AssetDTO } | undefined>(
      `/api/assets/${encodeURIComponent(id)}/neighbor${qs || '?'}${qs ? '&' : ''}direction=${direction}`,
      { signal },
    ).then((result) => result?.asset ?? null)
  },
  randomAsset: (
    body: {
      libraryId?: string
      folderId?: string
      kind?: AssetQuery['kind']
      tagId?: string
      q?: string
      currentAssetId?: string | null
      recentIds?: string[]
      seed?: number
    },
    signal?: AbortSignal,
  ) =>
    request<{ asset: AssetDTO } | undefined>('/api/assets/random', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    }).then((result) => result?.asset ?? null),
  incrementView: (id: string) => request<AssetDTO>(`/api/assets/${id}/view`, { method: 'POST' }),
  voteAsset: (id: string, clientRequestId?: string) =>
    request<AssetDTO>(`/api/assets/${id}/vote`, {
      method: 'POST',
      body: clientRequestId ? JSON.stringify({ clientRequestId }) : undefined,
    }),
  captureThumbnail: (id: string, positionMs: number) =>
    request<{ asset: AssetDTO }>(`/api/assets/${id}/thumbnail`, {
      method: 'POST',
      body: JSON.stringify({ positionMs }),
    }),
  deleteAsset: (id: string) => request<void>(`/api/assets/${id}`, { method: 'DELETE' }),
  retryHls: (id: string) =>
    request<HlsStatusDTO>(`/api/assets/${id}/hls/retry`, { method: 'POST' }),
  createDeleteOperation: (id: string, requestKey: string) =>
    request<FileOperationDTO>(`/api/assets/${id}/delete-operations`, {
      method: 'POST',
      headers: { 'Idempotency-Key': requestKey },
    }),
  getFileOperation: (id: string) => request<FileOperationDTO>(`/api/file-operations/${id}`),

  journalEntries: (cursor?: string | null) =>
    request<JournalEntryPageDTO>(`/api/journal${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`),
  createJournalEntry: () => request<JournalEntryDTO>('/api/journal', { method: 'POST' }),
  journalEntry: (id: string) => request<JournalEntryDTO>(`/api/journal/${encodeURIComponent(id)}`),
  updateJournalEntry: (id: string, body: { title: string; body: string; expectedUpdatedAt: string }) =>
    request<JournalEntryDTO>(`/api/journal/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteJournalEntry: (id: string) =>
    request<void>(`/api/journal/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  journalMentions: (q: string) =>
    request<{ items: JournalMentionDTO[] }>(`/api/journal/mentions?q=${encodeURIComponent(q)}`),

  tags: (kind: 'image' | 'video' = 'video') =>
    request<{ tags: TagSummaryDTO[] }>(`/api/tags?kind=${kind}`),
  createTag: (name: string, kind: 'image' | 'video' = 'video') =>
    request<{ tag: TagDTO }>(`/api/tags?kind=${kind}`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  renameTag: (id: string, name: string, kind: 'image' | 'video' = 'video') =>
    request<{ tag: TagDTO }>(`/api/tags/${id}?kind=${kind}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  deleteTag: (id: string, kind: 'image' | 'video' = 'video') =>
    request<void>(`/api/tags/${id}?kind=${kind}`, { method: 'DELETE' }),
  attachTag: (assetId: string, body: { tagId?: string; name?: string }) =>
    request<{ asset: AssetDTO }>(`/api/assets/${assetId}/tags`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  detachTag: (assetId: string, tagId: string) =>
    request<{ asset: AssetDTO }>(`/api/assets/${assetId}/tags/${tagId}`, {
      method: 'DELETE',
    }),

  related: (id: string, limit = 8) =>
    request<{ items: AssetDTO[]; basis: 'semantic' | 'folder' }>(
      `/api/assets/${id}/related?limit=${limit}`,
    ),
  review: (id: string) => request<{ review: ReviewDTO | null }>(`/api/assets/${id}/review`),
  saveReview: (id: string, input: { rating: number; body: string }) =>
    request<ReviewDTO>(`/api/assets/${id}/review`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteReview: (id: string) => request<void>(`/api/assets/${id}/review`, { method: 'DELETE' }),

  startPlaySession: (assetId: string, fileVersion: number, clientSessionKey: string) =>
    request<PlaySessionDTO>('/api/play-sessions', {
      method: 'POST',
      body: JSON.stringify({ assetId, fileVersion, clientSessionKey }),
    }),
  playEvent: (
    sessionId: string,
    event: {
      eventId: string
      seq: number
      type: PlayEventType
      deltaMs?: number
      positionMs?: number
      durationMs?: number
      clientTimestamp?: number
    },
    keepalive = false,
  ) =>
    request<PlayEventResultDTO>(`/api/play-sessions/${encodeURIComponent(sessionId)}/events`, {
      method: 'POST',
      keepalive,
      body: JSON.stringify(event),
    }),

  stats: () => request<StatsDTO>('/api/stats'),
  activityStats: () => request<ActivityStatsDTO>('/api/stats/activity'),
  votesActivityStats: () => request<VoteActivityStatsDTO>('/api/stats/votes-activity'),
  storageStats: (refresh = false) =>
    request<StorageStatsDTO>(`/api/stats/storage${refresh ? '?refresh=1' : ''}`),
  archives: () => request<{ archives: ArchiveJobDTO[] }>('/api/archives'),
  jobs: () => request<JobSummaryDTO>('/api/jobs'),
  pauseJob: (id: number) => request<{ job: JobDTO }>(`/api/jobs/${id}/pause`, { method: 'POST' }),
  resumeJob: (id: number) => request<{ job: JobDTO }>(`/api/jobs/${id}/resume`, { method: 'POST' }),
  cancelJob: (id: number) => request<{ job: JobDTO }>(`/api/jobs/${id}/cancel`, { method: 'POST' }),
  workQueue: () => request<WorkQueueDTO>('/api/queue'),
  systemStatus: () => request<SystemStatusDTO>('/api/system/status'),
  capabilities: () => request<CapabilitiesDTO>('/api/system/capabilities'),
  diagnostics: (format: 'json' | 'md' = 'json', refresh = false) =>
    request<DiagnosticsReportDTO>(
      `/api/system/diagnostics?format=${format}${refresh ? '&refresh=1' : ''}`,
    ),
  diagnosticsUrl: (format: 'json' | 'md') =>
    `/api/system/diagnostics?format=${format}&download=1`,
  metrics: () => request<SystemMetricsDTO>('/api/system/metrics'),
  cacheInventory: () => request<CacheInventoryDTO>('/api/system/cache'),
  searchIndex: () =>
    request<{ status: SearchIndexStatusDTO; builds: SearchIndexBuildDTO[] }>(
      '/api/system/search-index',
    ),
  rebuildSearchIndex: () =>
    request<SearchIndexBuildDTO>('/api/system/search-index/rebuild', { method: 'POST' }),
  searchIndexGcPreview: () =>
    request<SearchIndexGcPreviewDTO>('/api/system/search-index/gc/preview'),
  cleanSearchIndexBuilds: () =>
    request<{ deleted: number }>('/api/system/search-index/gc', { method: 'POST' }),
  previewCacheCleanup: () =>
    request<CacheCleanupPreviewDTO>('/api/system/cache/preview', { method: 'POST' }),
  cleanCache: (generation: string) =>
    request<CacheCleanupResultDTO>('/api/system/cache/clean', {
      method: 'POST',
      body: JSON.stringify({ generation }),
    }),
  notifications: (params?: { state?: string; limit?: number; cursor?: string | null }) => {
    const search = new URLSearchParams()
    if (params?.state) search.set('state', params.state)
    if (params?.limit) search.set('limit', String(params.limit))
    if (params?.cursor) search.set('cursor', params.cursor)
    const qs = search.toString()
    return request<NotificationListDTO>(`/api/notifications${qs ? `?${qs}` : ''}`)
  },
  notificationsUnread: () => request<NotificationUnreadDTO>('/api/notifications/unread'),
  readNotification: (id: string) =>
    request<{ notification: NotificationDTO }>(`/api/notifications/${encodeURIComponent(id)}/read`, {
      method: 'POST',
    }),
  dismissNotification: (id: string) =>
    request<{ notification: NotificationDTO }>(
      `/api/notifications/${encodeURIComponent(id)}/dismiss`,
      { method: 'POST' },
    ),
  backups: () => request<{ backups: BackupRecordDTO[] }>('/api/backups'),
  createBackup: () => request<{ backup: BackupRecordDTO }>('/api/backups', { method: 'POST' }),
  fsDrives: () => request<{ drives: HostDriveDTO[] }>('/api/fs/drives'),
  fsBrowse: (targetPath = '', q = '') => {
    const params = new URLSearchParams()
    if (targetPath) params.set('path', targetPath)
    if (q) params.set('q', q)
    const qs = params.toString()
    return request<HostBrowseResponseDTO>(`/api/fs/browse${qs ? `?${qs}` : ''}`)
  },

  duplicateGroups: (opts?: {
    kind?: 'exact' | 'similar'
    state?: 'open' | 'kept' | 'ignored' | 'all'
    limit?: number
    cursor?: string | null
  }) => {
    const params = new URLSearchParams()
    if (opts?.kind) params.set('kind', opts.kind)
    if (opts?.state) params.set('state', opts.state)
    if (opts?.limit) params.set('limit', String(opts.limit))
    if (opts?.cursor) params.set('cursor', opts.cursor)
    const qs = params.toString()
    return request<DuplicateGroupListDTO>(`/api/duplicates/groups${qs ? `?${qs}` : ''}`)
  },
  duplicateGroup: (id: string) =>
    request<DuplicateGroupDTO>(`/api/duplicates/groups/${encodeURIComponent(id)}`),
  scanDuplicates: (libraryId?: string) =>
    request<{ jobId: number; dedupeKey: string; state: string }>('/api/duplicates/scans', {
      method: 'POST',
      body: JSON.stringify(libraryId ? { libraryId } : {}),
    }),
  decideDuplicateGroup: (id: string, action: 'keep' | 'ignore') =>
    request<{ id: string; state: string }>(
      `/api/duplicates/groups/${encodeURIComponent(id)}/decisions`,
      { method: 'POST', body: JSON.stringify({ action }) },
    ),
  runIndex: () =>
    request<{
      scanned: number
      considered: number
      asr: number
      translations: number
      embeddings: number
      scenes: number
    }>('/api/index/run', { method: 'POST' }),

  bookmarks: (assetId: string) =>
    request<{ bookmarks: VideoBookmarkDTO[] }>(`/api/assets/${assetId}/bookmarks`),
  createBookmark: (assetId: string, body: { positionMs: number; title?: string; note?: string }) =>
    request<VideoBookmarkDTO>(`/api/assets/${assetId}/bookmarks`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateBookmark: (
    id: string,
    body: { positionMs?: number; title?: string | null; note?: string | null },
  ) => request<VideoBookmarkDTO>(`/api/bookmarks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteBookmark: (id: string) => request<void>(`/api/bookmarks/${id}`, { method: 'DELETE' }),

  transcriptionStatus: (id: string) =>
    request<TranscriptionStatusDTO>(`/api/assets/${id}/transcription/status`),
  createTranscription: (id: string, force = false) =>
    request<{ job: unknown; transcript: unknown }>(`/api/assets/${id}/transcribe`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),
  transcript: (id: string) => request<TranscriptDTO>(`/api/assets/${id}/transcription`),
  searchTranscript: (id: string, q: string, lang?: string) =>
    request<TranscriptSearchDTO>(
      withLang(`/api/assets/${id}/transcript/search?q=${encodeURIComponent(q)}`, lang),
    ),
  subtitleTracks: (id: string) => request<SubtitleTracksDTO>(`/api/assets/${id}/subtitle-tracks`),
  translationStatus: (id: string, lang?: string) =>
    request<TranslationStatusDTO>(withLang(`/api/assets/${id}/translations/status`, lang)),
  createTranslation: (id: string, target?: string, force = false) =>
    request<{ job: TranslationJobDTO | null; translation: TranslationSummaryDTO | null }>(
      `/api/assets/${id}/translations`,
      {
        method: 'POST',
        body: JSON.stringify({
          ...(target ? { targetLanguage: target } : {}),
          ...(force ? { force } : {}),
        }),
      },
    ),
  translation: (id: string, lang?: string) =>
    request<TranslationDTO>(withLang(`/api/assets/${id}/translation`, lang)),
  vttUrl: (id: string, version: number, lang?: string) =>
    withLang(`/api/assets/${id}/subtitles.vtt?v=${version}`, lang),
  srtUrl: (id: string, version: number, lang?: string) =>
    withLang(`/api/assets/${id}/subtitles.srt?v=${version}`, lang),
}
