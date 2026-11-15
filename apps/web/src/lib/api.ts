import type {
  AssetDTO,
  AssetQuery,
  AuthStatusDTO,
  FolderDTO,
  JobSummaryDTO,
  LibraryDTO,
  Page,
  PlaybackProgressDTO,
  ReviewDTO,
  StatsDTO,
  SubtitleTracksDTO,
  TranscriptDTO,
  TranscriptSearchDTO,
  TranscriptionStatusDTO,
  TranslationDTO,
  TranslationJobDTO,
  TranslationStatusDTO,
  TranslationSummaryDTO,
  UserDTO,
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
  if (query.favorite) params.set('favorite', '1')
  if (query.q) params.set('q', query.q)
  if (query.cursor) params.set('cursor', query.cursor)
  if (query.limit) params.set('limit', String(query.limit))
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** A missing `lang` and `original` both resolve to the source transcript. */
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
  deleteLibrary: (id: string) => request<void>(`/api/libraries/${id}`, { method: 'DELETE' }),

  folders: () => request<FolderDTO[]>('/api/folders'),
  folder: (id: string) => request<FolderDetail>(`/api/folders/${id}`),

  assets: (query: AssetQuery) => request<Page<AssetDTO>>(`/api/assets${queryString(query)}`),
  asset: (id: string) => request<AssetDTO>(`/api/assets/${id}`),
  setFavorite: (id: string, favorite: boolean) =>
    request<void>(`/api/assets/${id}/favorite`, { method: favorite ? 'POST' : 'DELETE' }),

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
  jobs: () => request<JobSummaryDTO>('/api/jobs'),
  workQueue: () => request<WorkQueueDTO>('/api/queue'),

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
