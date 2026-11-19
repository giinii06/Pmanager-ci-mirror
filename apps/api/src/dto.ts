import type {
  ArchiveJobDTO,
  AsrJobDTO,
  AssetDTO,
  EmbeddingJobDTO,
  FolderDTO,
  FileOperationDTO,
  JobDTO,
  LibraryDTO,
  LibraryHealthDetailDTO,
  PlaybackProgressDTO,
  ReviewDTO,
  SceneJobDTO,
  ScanRunDTO,
  TagDTO,
  TagSummaryDTO,
  TranscriptDTO,
  TranscriptSummaryDTO,
  TranslationDTO,
  TranslationJobDTO,
  TranslationSummaryDTO,
  UserDTO,
  WorkItemDTO,
  WorkQueueDTO,
} from '@mediavault/shared'
import { POSTER_SCHEME, playbackModeFor } from '@mediavault/shared'
import type {
  ArchiveJobRecord,
  AsrJobRecord,
  AssetRecord,
  EmbeddingJobRecord,
  FileMutationRecord,
  FolderRecord,
  JobRecord,
  LibraryHealthRecord,
  LibraryRecord,
  PlaybackRecord,
  ReviewRecord,
  ScanRunRecord,
  SceneJobRecord,
  TagRecord,
  TagSummaryRecord,
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

export function toLibraryDTO(
  library: LibraryRecord,
  health?: LibraryHealthRecord | null,
): LibraryDTO {
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
    healthState: health?.state ?? 'UNVERIFIED',
    healthErrorCode: health?.lastErrorCode ?? null,
    healthCheckedAt: iso(health?.checkedAt ?? null),
    healthConsecutiveFailures: health?.consecutiveFailures ?? 0,
  }
}

export function toScanRunDTO(scan: ScanRunRecord): ScanRunDTO {
  return {
    id: scan.id,
    phase: scan.phase,
    status: scan.status,
    filesSeen: scan.filesSeen,
    filesAdded: scan.filesAdded,
    filesUpdated: scan.filesUpdated,
    filesSkipped: scan.filesSkipped,
    filesRemoved: scan.filesRemoved,
    readErrors: scan.readErrors,
    missingCount: scan.missingCount,
    missingRatio: scan.missingRatio,
    authoritativeVerified: scan.authoritativeVerified === 1,
    healthState: scan.healthState,
    errorMessage: scan.errorMessage,
    startedAt: new Date(scan.startedAt).toISOString(),
    completedAt: iso(scan.completedAt),
  }
}

export function toLibraryHealthDetailDTO(
  libraryId: string,
  health: LibraryHealthRecord | null,
  scan: ScanRunRecord | null,
): LibraryHealthDetailDTO {
  return {
    libraryId,
    state: health?.state ?? 'UNVERIFIED',
    rootIdentity: health?.rootIdentity ?? null,
    lastSuccessAt: iso(health?.lastSuccessAt ?? null),
    lastErrorCode: health?.lastErrorCode ?? null,
    checkedAt: iso(health?.checkedAt ?? null),
    consecutiveFailures: health?.consecutiveFailures ?? 0,
    scan: scan ? toScanRunDTO(scan) : null,
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
    coverWidth: folder.coverWidth,
    coverHeight: folder.coverHeight,
    coverPosterVersion: folder.coverPosterVersion,
    coverFileVersion: folder.coverFileVersion,
    viewCount: folder.viewCount,
    voteCount: folder.voteCount,
    rate: folder.rate,
    createdAt: new Date(folder.createdAt).toISOString(),
  }
}

export function toAssetDTO(asset: AssetRecord): AssetDTO {
  const version = asset.fileVersion
  const posterVersion = asset.posterVersion
  const posterQuery = asset.kind === 'video' ? `&p=${POSTER_SCHEME}` : ''
  return {
    id: asset.id,
    libraryId: asset.libraryId,
    folderId: asset.folderId,
    kind: asset.kind,
    filename: asset.filename,
    relativePath: asset.relativePath,
    mimeType: asset.mimeType,
    container: asset.container,
    videoCodec: asset.videoCodec,
    audioCodec: asset.audioCodec,
    sizeBytes: asset.sizeBytes,
    width: asset.width,
    height: asset.height,
    durationMs: asset.durationMs,
    takenAt: new Date(asset.takenAt).toISOString(),
    viewCount: asset.viewCount,
    watchTimeMs: asset.watchTimeMs,
    voteCount: asset.voteCount,
    rate: asset.rate,
    posterVersion,
    tags: asset.tags,
    fileVersion: version,
    playback: playbackModeFor({
      kind: asset.kind,
      container: asset.container,
      videoCodec: asset.videoCodec,
      audioCodec: asset.audioCodec,
    }),
    thumbnails: {
      small: `/api/assets/${asset.id}/thumbnail?size=320&v=${version}&pv=${posterVersion}${posterQuery}`,
      medium: `/api/assets/${asset.id}/thumbnail?size=640&v=${version}&pv=${posterVersion}${posterQuery}`,
    },
    previewUrl: `/api/assets/${asset.id}/preview?v=${version}`,
    streamUrl: `/api/assets/${asset.id}/stream?v=${version}`,
    hlsUrl: `/api/assets/${asset.id}/hls/master.m3u8`,
    hlsStatusUrl: `/api/assets/${asset.id}/hls`,
  }
}

export function toTagDTO(tag: TagRecord): TagDTO {
  return {
    id: tag.id,
    name: tag.name,
    createdAt: new Date(tag.createdAt).toISOString(),
  }
}

export function toTagSummaryDTO(tag: TagSummaryRecord): TagSummaryDTO {
  return {
    id: tag.id,
    name: tag.name,
    assetCount: tag.assetCount,
    coverAssetId: tag.coverAssetId,
    coverPosterVersion: tag.coverPosterVersion,
    createdAt: new Date(tag.createdAt).toISOString(),
  }
}

export function toArchiveJobDTO(job: ArchiveJobRecord): ArchiveJobDTO {
  return {
    id: job.id,
    libraryId: job.libraryId,
    archivePath: job.archivePath,
    state: job.state,
    passwordUsed: job.passwordUsed,
    extractedFiles: job.extractedFiles,
    convertedImages: job.convertedImages,
    convertedVideos: job.convertedVideos,
    errorMessage: job.errorMessage,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
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
    workerId: job.workerId,
    leaseEpoch: job.leaseEpoch,
    leaseExpiresAt: iso(job.leaseExpiresAt),
    progressCurrent: job.progressCurrent,
    progressTotal: job.progressTotal,
    phase: job.phase,
    pauseRequested: job.pauseRequested === 1,
    cancelRequested: job.cancelRequested === 1,
    completedAt: iso(job.completedAt),
    lastError: job.lastError,
    updatedAt: new Date(job.updatedAt).toISOString(),
  }
}

export function toPlaybackDTO(progress: PlaybackRecord): PlaybackProgressDTO {
  return {
    assetId: progress.assetId,
    positionMs: progress.positionMs,
    durationMs: progress.durationMs,
    fileVersion: progress.fileVersion,
    progressVersion: progress.progressVersion,
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
    language: transcript.hasSpeech === 1 ? transcript.language : null,
    hasSpeech: transcript.hasSpeech === 1,
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
    language: transcript.hasSpeech === 1 ? transcript.language : null,
    hasSpeech: transcript.hasSpeech === 1,
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

export function toEmbeddingJobDTO(job: EmbeddingJobRecord): EmbeddingJobDTO {
  return {
    id: job.id,
    assetId: job.assetId,
    fileVersion: job.fileVersion,
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

export function toSceneJobDTO(job: SceneJobRecord): SceneJobDTO {
  return {
    id: job.id,
    assetId: job.assetId,
    fileVersion: job.fileVersion,
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

export function toFileOperationDTO(record: FileMutationRecord): FileOperationDTO {
  return {
    id: record.id,
    kind: record.kind,
    assetId: record.assetId,
    state: record.state,
    errorCode: record.errorCode,
    attempts: record.attempts,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
    completedAt: iso(record.completedAt),
    statusUrl: `/api/file-operations/${record.id}`,
  }
}
