import type {
  ActivityStatsDTO,
  ArchiveJobDTO,
  AssetDTO,
  DuplicateGroupDTO,
  DuplicateGroupListDTO,
  AssetQuery,
  AuthStatusDTO,
  BackupRecordDTO,
  BulkOperationDTO,
  BulkOperationDetailDTO,
  BulkOperationItemDTO,
  BulkOperationKind,
  BulkOperationListDTO,
  BulkOperationParams,
  BulkPreviewDTO,
  BulkSelection,
  FolderDTO,
  FolderSort,
  FileOperationDTO,
  FilterTree,
  HostBrowseResponseDTO,
  HostDriveDTO,
  HlsStatusDTO,
  JobDTO,
  JobSummaryDTO,
  LibraryDTO,
  LibraryHealthDetailDTO,
  Page,
  PlayEventResultDTO,
  PlayEventType,
  PlaySessionDTO,
  PlaybackProgressDTO,
  PlaylistAssetsDTO,
  PlaylistDTO,
  PlaylistDetailDTO,
  PlaylistItemDTO,
  ReviewDTO,
  SemanticSearchDTO,
  SmartAlbumDTO,
  StatsDTO,
  StorageStatsDTO,
  SubtitleTracksDTO,
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
  VideoSort,
  VoteActivityStatsDTO,
  WorkQueueDTO,
} from '@mediavault/shared'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
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
    try {
      const body = (await response.json()) as { message?: string; error?: string }
      if (body?.message) message = body.message
      if (body?.error) code = body.error
    } catch {
      // Keep the status message.
    }
    throw new ApiError(response.status, message, code)
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
  if (query.albumId) params.set('albumId', query.albumId)
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

  bulkPreview: (body: {
    kind: BulkOperationKind
    selection: BulkSelection
    params?: BulkOperationParams
  }) =>
    request<BulkPreviewDTO>('/api/bulk-operations/preview', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  createBulkOperation: (body: {
    kind: BulkOperationKind
    selection: BulkSelection
    params?: BulkOperationParams
    requestId: string
    generation: string
    expectedCount: number
  }) =>
    request<{ operationId: string; state: string; statusUrl: string; created: boolean }>(
      '/api/bulk-operations',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  bulkOperations: () => request<BulkOperationListDTO>('/api/bulk-operations'),
  bulkOperation: (
    id: string,
    opts?: { itemState?: string; itemLimit?: number; itemOffset?: number },
  ) => {
    const params = new URLSearchParams()
    if (opts?.itemState) params.set('itemState', opts.itemState)
    if (opts?.itemLimit !== undefined) params.set('itemLimit', String(opts.itemLimit))
    if (opts?.itemOffset !== undefined) params.set('itemOffset', String(opts.itemOffset))
    const qs = params.toString()
    return request<BulkOperationDetailDTO>(`/api/bulk-operations/${id}${qs ? `?${qs}` : ''}`)
  },
  bulkOperationItems: (
    id: string,
    opts?: { state?: string; limit?: number; offset?: number },
  ) => {
    const params = new URLSearchParams()
    if (opts?.state) params.set('state', opts.state)
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
    if (opts?.offset !== undefined) params.set('offset', String(opts.offset))
    const qs = params.toString()
    return request<{ items: BulkOperationItemDTO[] }>(
      `/api/bulk-operations/${id}/items${qs ? `?${qs}` : ''}`,
    )
  },
  cancelBulkOperation: (id: string) =>
    request<{ state: string }>(`/api/bulk-operations/${id}/cancel`, { method: 'POST' }),
  retryBulkOperation: (id: string, itemIds?: string[]) =>
    request<{ reset: number }>(`/api/bulk-operations/${id}/retry`, {
      method: 'POST',
      body: JSON.stringify(itemIds ? { itemIds } : {}),
    }),
  bulkExportUrl: (id: string) => `/api/bulk-operations/${id}/export`,

  tags: () => request<{ tags: TagSummaryDTO[] }>('/api/tags'),
  createTag: (name: string) =>
    request<{ tag: TagDTO }>('/api/tags', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  renameTag: (id: string, name: string) =>
    request<{ tag: TagDTO }>(`/api/tags/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  deleteTag: (id: string) => request<void>(`/api/tags/${id}`, { method: 'DELETE' }),
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

  progress: (id: string) =>
    request<{ progress: PlaybackProgressDTO | null }>(`/api/playback/${id}`),
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

  semanticSearch: (q: string, limit = 30) =>
    request<SemanticSearchDTO>(
      `/api/search/semantic?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),

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

  smartAlbums: () => request<{ albums: SmartAlbumDTO[] }>('/api/smart-albums'),
  smartAlbum: (id: string) => request<SmartAlbumDTO>(`/api/smart-albums/${id}`),
  createSmartAlbum: (body: {
    name: string
    description?: string | null
    filter: FilterTree
    sort?: VideoSort | null
    pinned?: boolean
  }) => request<SmartAlbumDTO>('/api/smart-albums', { method: 'POST', body: JSON.stringify(body) }),
  updateSmartAlbum: (
    id: string,
    body: Partial<{
      name: string
      description: string | null
      filter: FilterTree
      sort: VideoSort | null
      pinned: boolean
    }>,
  ) =>
    request<SmartAlbumDTO>(`/api/smart-albums/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteSmartAlbum: (id: string) =>
    request<void>(`/api/smart-albums/${id}`, { method: 'DELETE' }),

  playlists: () => request<{ playlists: PlaylistDTO[] }>('/api/playlists'),
  playlist: (id: string) => request<PlaylistDetailDTO>(`/api/playlists/${id}`),
  createPlaylist: (body: { name: string; description?: string | null }) =>
    request<PlaylistDTO>('/api/playlists', { method: 'POST', body: JSON.stringify(body) }),
  updatePlaylist: (id: string, body: { name?: string; description?: string | null }) =>
    request<PlaylistDTO>(`/api/playlists/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deletePlaylist: (id: string) => request<void>(`/api/playlists/${id}`, { method: 'DELETE' }),
  playlistAssets: (id: string) => request<PlaylistAssetsDTO>(`/api/playlists/${id}/assets`),
  addPlaylistItem: (id: string, assetId: string) =>
    request<{ playlist: PlaylistDTO; item: PlaylistItemDTO }>(`/api/playlists/${id}/items`, {
      method: 'POST',
      body: JSON.stringify({ assetId }),
    }),
  movePlaylistItem: (id: string, itemId: string, position: number) =>
    request<PlaylistDetailDTO>(`/api/playlists/${id}/items/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ position }),
    }),
  removePlaylistItem: (id: string, itemId: string) =>
    request<void>(`/api/playlists/${id}/items/${itemId}`, { method: 'DELETE' }),
  ensureWatchLater: () =>
    request<{ playlist: PlaylistDTO }>('/api/playlists/watch-later', { method: 'POST' }),
  /** Every playlist surface needs the default list to exist before it can show it. */
  playlistsWithWatchLater: async () => {
    await api.ensureWatchLater()
    return api.playlists()
  },
  addWatchLater: (assetId: string) =>
    request<{ playlist: PlaylistDTO; item: PlaylistItemDTO }>('/api/playlists/watch-later/items', {
      method: 'POST',
      body: JSON.stringify({ assetId }),
    }),

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
