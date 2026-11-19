import type {
  ActivityStatsDTO,
  ArchiveJobDTO,
  AssetDTO,
  AssetQuery,
  AuthStatusDTO,
  BackupRecordDTO,
  FolderDTO,
  FolderSort,
  HostBrowseResponseDTO,
  HostDriveDTO,
  JobDTO,
  JobSummaryDTO,
  LibraryDTO,
  LibraryHealthDetailDTO,
  Page,
  PlaybackProgressDTO,
  ReviewDTO,
  SemanticSearchDTO,
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
  VoteActivityStatsDTO,
  WorkQueueDTO,
} from '@mediavault/shared'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
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
    try {
      const body = (await response.json()) as { message?: string }
      if (body?.message) message = body.message
    } catch {
      // Keep the status message.
    }
    throw new ApiError(response.status, message)
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
  voteFolder: (id: string) => request<FolderDTO>(`/api/folders/${id}/vote`, { method: 'POST' }),
  setFolderCover: (id: string, assetId: string) =>
    request<FolderDTO>(`/api/folders/${encodeURIComponent(id)}/cover`, {
      method: 'PUT',
      body: JSON.stringify({ assetId }),
    }),

  assets: (query: AssetQuery) => request<Page<AssetDTO>>(`/api/assets${queryString(query)}`),
  assetIds: (query: AssetQuery) => request<{ ids: string[] }>(`/api/assets/ids${queryString(query)}`),
  asset: (id: string) => request<AssetDTO>(`/api/assets/${id}`),
  incrementView: (id: string) => request<AssetDTO>(`/api/assets/${id}/view`, { method: 'POST' }),
  addWatchTime: (id: string, deltaMs: number, keepalive = false) =>
    request<AssetDTO>(`/api/assets/${id}/watch-time`, {
      method: 'POST',
      keepalive,
      body: JSON.stringify({ deltaMs }),
    }),
  voteAsset: (id: string) => request<AssetDTO>(`/api/assets/${id}/vote`, { method: 'POST' }),
  captureThumbnail: (id: string, positionMs: number) =>
    request<{ asset: AssetDTO }>(`/api/assets/${id}/thumbnail`, {
      method: 'POST',
      body: JSON.stringify({ positionMs }),
    }),
  deleteAsset: (id: string) => request<void>(`/api/assets/${id}`, { method: 'DELETE' }),

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
  saveProgress: (id: string, positionMs: number, durationMs: number) =>
    request<void>(`/api/playback/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ positionMs, durationMs }),
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
  runIndex: () =>
    request<{
      scanned: number
      considered: number
      asr: number
      translations: number
      embeddings: number
      scenes: number
    }>('/api/index/run', { method: 'POST' }),

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
