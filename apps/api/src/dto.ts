import type {
  AssetDTO,
  FolderDTO,
  JobDTO,
  LibraryDTO,
  PlaybackProgressDTO,
  UserDTO,
} from '@mediavault/shared'
import { playbackModeFor } from '@mediavault/shared'
import type {
  AssetRecord,
  FolderRecord,
  JobRecord,
  LibraryRecord,
  PlaybackRecord,
  UserRecord,
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
