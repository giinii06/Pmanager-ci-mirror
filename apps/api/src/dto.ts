import type {
  AsrJobDTO,
  AssetDTO,
  FolderDTO,
  JobDTO,
  LibraryDTO,
  PlaybackProgressDTO,
  ReviewDTO,
  TranscriptDTO,
  TranscriptSummaryDTO,
  TranslationDTO,
  TranslationJobDTO,
  TranslationSummaryDTO,
  UserDTO,
  WorkItemDTO,
  WorkQueueDTO,
} from '@mediavault/shared'
import { playbackModeFor } from '@mediavault/shared'
import type {
  AsrJobRecord,
  AssetRecord,
  FolderRecord,
  JobRecord,
  LibraryRecord,
  PlaybackRecord,
  ReviewRecord,
  TranscriptRecord,
  TranscriptWithSegments,
  TranslationJobRecord,
  TranslationRecord,
  TranslationWithSegments,
  UserRecord,
  WorkItemRecord,
  WorkQueueRecord,
} from '@mediavault/database'

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString()
}

export function toUserDTO(user: UserRecord): UserDTO {
  return { id: user.id, username: user.username }
}

export function toLibraryDTO(library: LibraryRecord): LibraryDTO {
  return {
    id: library.id,
    name: library.name,
    rootPath: library.rootPath,
    createdAt: new Date(library.createdAt).toISOString(),
    lastScanAt: iso(library.lastScanAt),
    scanState: library.scanState,
    scannedFiles: library.scannedFiles,
    assetCount: library.assetCount,
    folderCount: library.folderCount,
  }
}

export function toFolderDTO(folder: FolderRecord): FolderDTO {
  return {
    id: folder.id,
    libraryId: folder.libraryId,
    parentId: folder.parentId,
    name: folder.name,
    relativePath: folder.relativePath,
    depth: folder.depth,
    assetCount: folder.assetCount,
    directImageCount: folder.directImageCount,
    coverAssetId: folder.coverAssetId,
  }
}

export function toAssetDTO(asset: AssetRecord): AssetDTO {
  const version = asset.fileVersion
  return {
    id: asset.id,
    libraryId: asset.libraryId,
    folderId: asset.folderId,
    kind: asset.kind,
    filename: asset.filename,
    relativePath: asset.relativePath,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    width: asset.width,
    height: asset.height,
    durationMs: asset.durationMs,
    takenAt: new Date(asset.takenAt).toISOString(),
    favorite: asset.favorite,
    fileVersion: version,
    playback: playbackModeFor({
      kind: asset.kind,
      container: asset.container,
      videoCodec: asset.videoCodec,
      audioCodec: asset.audioCodec,
    }),
    thumbnails: {
      small: `/api/assets/${asset.id}/thumbnail?size=320&v=${version}`,
      medium: `/api/assets/${asset.id}/thumbnail?size=640&v=${version}`,
    },
    previewUrl: `/api/assets/${asset.id}/preview?v=${version}`,
    streamUrl: `/api/assets/${asset.id}/stream?v=${version}`,
    hlsUrl: `/api/assets/${asset.id}/hls/master.m3u8`,
  }
}

export function toJobDTO(job: JobRecord): JobDTO {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    priority: job.priority,
    assetId: job.assetId,
    libraryId: job.libraryId,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    lastError: job.lastError,
    updatedAt: new Date(job.updatedAt).toISOString(),
  }
}

export function toPlaybackDTO(progress: PlaybackRecord): PlaybackProgressDTO {
  return {
    assetId: progress.assetId,
    positionMs: progress.positionMs,
    durationMs: progress.durationMs,
    updatedAt: new Date(progress.updatedAt).toISOString(),
  }
}

export function toReviewDTO(review: ReviewRecord): ReviewDTO {
  return {
    id: review.id,
    assetId: review.assetId,
    rating: review.rating,
    body: review.body,
    createdAt: new Date(review.createdAt).toISOString(),
    updatedAt: new Date(review.updatedAt).toISOString(),
  }
}

export function toAsrJobDTO(job: AsrJobRecord): AsrJobDTO {
  return {
    id: job.id,
    assetId: job.assetId,
    fileVersion: job.fileVersion,
    modelRevision: job.modelRevision,
    alignerRevision: job.alignerRevision,
    pipelineVersion: job.pipelineVersion,
    state: job.state,
    stage: job.stage,
    progress: job.progress,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    errorMessage: job.errorMessage,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
  }
}

export function toTranscriptSummaryDTO(
  transcript: TranscriptRecord,
  segmentCount: number,
): TranscriptSummaryDTO {
  return {
    id: transcript.id,
    language: transcript.language,
    segmentCount,
    createdAt: new Date(transcript.createdAt).toISOString(),
  }
}

export function toTranscriptDTO(stored: TranscriptWithSegments): TranscriptDTO {
  const { transcript, segments } = stored
  return {
    id: transcript.id,
    assetId: transcript.assetId,
    fileVersion: transcript.fileVersion,
    language: transcript.language,
    plainText: transcript.plainText,
    segments: segments.map((segment) => ({
      seq: segment.seq,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
    })),
    createdAt: new Date(transcript.createdAt).toISOString(),
  }
}

export function toTranslationJobDTO(job: TranslationJobRecord): TranslationJobDTO {
  return {
    id: job.id,
    assetId: job.assetId,
    fileVersion: job.fileVersion,
    sourceLanguage: job.sourceLanguage,
    targetLanguage: job.targetLanguage,
    state: job.state,
    stage: job.stage,
    progress: job.progress,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    errorMessage: job.errorMessage,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
  }
}

export function toTranslationSummaryDTO(
  translation: TranslationRecord,
  segmentCount: number,
): TranslationSummaryDTO {
  return {
    id: translation.id,
    sourceLanguage: translation.sourceLanguage,
    targetLanguage: translation.targetLanguage,
    segmentCount,
    createdAt: new Date(translation.createdAt).toISOString(),
  }
}

export function toTranslationDTO(stored: TranslationWithSegments): TranslationDTO {
  const { translation, segments } = stored
  return {
    id: translation.id,
    assetId: translation.assetId,
    fileVersion: translation.fileVersion,
    sourceLanguage: translation.sourceLanguage,
    targetLanguage: translation.targetLanguage,
    plainText: translation.plainText,
    segments: segments.map((segment) => ({
      seq: segment.seq,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
    })),
    createdAt: new Date(translation.createdAt).toISOString(),
  }
}

function toWorkItemDTO(item: WorkItemRecord): WorkItemDTO {
  return {
    id: item.id,
    pipeline: item.pipeline,
    kind: item.kind as WorkItemDTO['kind'],
    assetId: item.assetId,
    assetName: item.assetName,
    state: item.state,
    stage: item.stage,
    progress: item.progress,
    onGpu: item.onGpu,
    startedAt: iso(item.startedAt),
    updatedAt: iso(item.updatedAt),
    etaSeconds: item.etaSeconds,
    errorMessage: item.errorMessage,
  }
}

export function toWorkQueueDTO(queue: WorkQueueRecord): WorkQueueDTO {
  return {
    generatedAt: new Date(queue.generatedAt).toISOString(),
    running: queue.running.map(toWorkItemDTO),
    queued: queue.queued.map(toWorkItemDTO),
    stalled: queue.stalled.map(toWorkItemDTO),
    remaining: queue.remaining,
    etaSeconds: queue.etaSeconds,
    basis: queue.basis,
    pipelines: queue.pipelines,
    failures: queue.failures.map(toWorkItemDTO),
    lastCompletedAt: iso(queue.lastCompletedAt),
  }
}
