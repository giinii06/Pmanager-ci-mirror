import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  deleteStaleFolders,
  enqueueJob,
  findAssetForScan,
  finishScan,
  getLibrary,
  insertAsset,
  recomputeFolderCounts,
  softDeleteMissing,
  touchAsset,
  updateAssetFile,
  updateScanProgress,
  upsertFolder,
  type Db,
} from '@mediavault/database'
import { PRIORITY, classifyFile, extensionOf, newId } from '@mediavault/shared'
import { probeImage, probeVideo, resolveInside } from '@mediavault/media'
import type { WorkerConfig } from './config'

const SKIP_DIRECTORIES = new Set([
  '@eaDir',
  '#recycle',
  '$RECYCLE.BIN',
  'System Volume Information',
  'lost+found',
])

export interface ScanSummary {
  files: number
  added: number
  updated: number
  removed: number
  skipped: number
}

export async function scanLibrary(
  db: Db,
  config: WorkerConfig,
  libraryId: string,
): Promise<ScanSummary> {
  const library = getLibrary(db, libraryId)
  if (!library) throw new Error(`library ${libraryId} no longer exists`)
  const root = resolveInside(config.mediaRoot, library.rootPath)
  if (!root) throw new Error(`library root escapes MEDIA_ROOT: ${library.rootPath}`)

  const scanId = `scan-${Date.now()}-${newId(6)}`
  const summary: ScanSummary = { files: 0, added: 0, updated: 0, removed: 0, skipped: 0 }

  const indexFile = async (absolute: string, relative: string, folderId: string): Promise<void> => {
    const filename = path.basename(absolute)
    const type = classifyFile(filename)
    if (!type) return

    let fileInfo
    try {
      fileInfo = await stat(absolute)
    } catch {
      return
    }
    if (!fileInfo.isFile()) return

    const mtimeMs = Math.round(fileInfo.mtimeMs)
    const existing = findAssetForScan(db, libraryId, relative)

    if (
      existing &&
      existing.deletedAt === null &&
      existing.sizeBytes === fileInfo.size &&
      existing.mtimeMs === mtimeMs
    ) {
      touchAsset(db, existing.id, scanId)
      summary.files += 1
      return
    }

    let width: number | null = null
    let height: number | null = null
    let durationMs: number | null = null
    let takenAt = fileInfo.mtimeMs
    let videoCodec: string | null = null
    let audioCodec: string | null = null

    try {
      if (type.kind === 'image') {
        const probe = await probeImage(absolute, fileInfo.mtimeMs)
        width = probe.width
        height = probe.height
        takenAt = probe.takenAt
      } else {
        const probe = await probeVideo(absolute, fileInfo.mtimeMs)
        width = probe.width
        height = probe.height
        durationMs = probe.durationMs
        takenAt = probe.takenAt
        videoCodec = probe.videoCodec
        audioCodec = probe.audioCodec
      }
    } catch (error) {
      console.warn(`[scan] skipped ${relative}: ${(error as Error).message}`)
      if (existing) touchAsset(db, existing.id, scanId)
      summary.skipped += 1
      return
    }

    const container = extensionOf(filename)
    const indexedAt = Date.now()
    let assetId: string
    let version: number

    if (existing) {
      updateAssetFile(db, existing.id, {
        folderId,
        filename,
        mimeType: type.mimeType,
        sizeBytes: fileInfo.size,
        mtimeMs,
        width,
        height,
        durationMs,
        takenAt,
        videoCodec,
        audioCodec,
        container,
        indexedAt,
        scanId,
      })
      assetId = existing.id
      version = existing.fileVersion + 1
      summary.updated += 1
    } else {
      assetId = newId()
      insertAsset(db, {
        id: assetId,
        libraryId,
        folderId,
        relativePath: relative,
        filename,
        kind: type.kind,
        mimeType: type.mimeType,
        sizeBytes: fileInfo.size,
        mtimeMs,
        width,
        height,
        durationMs,
        takenAt,
        videoCodec,
        audioCodec,
        container,
        indexedAt,
        scanId,
      })
      version = 1
      summary.added += 1
    }

    enqueueJob(
      db,
      {
        dedupeKey: `thumbnail:${assetId}:${version}`,
        kind: 'thumbnail',
        priority: PRIORITY.backlog,
        assetId,
      },
      indexedAt,
    )
    summary.files += 1
  }

  const walk = async (
    absolute: string,
    relative: string,
    parentId: string | null,
    depth: number,
  ): Promise<void> => {
    const folderId = upsertFolder(db, {
      id: newId(),
      libraryId,
      parentId,
      relativePath: relative,
      name: relative === '' ? library.name : path.basename(absolute),
      depth,
      scanId,
    })

    const entries = await readdir(absolute, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`
      const childAbsolute = path.join(absolute, entry.name)

      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        await walk(childAbsolute, childRelative, folderId, depth + 1)
        continue
      }
      if (!entry.isFile()) continue

      await indexFile(childAbsolute, childRelative, folderId)
      if (summary.files > 0 && summary.files % 50 === 0) {
        updateScanProgress(db, libraryId, summary.files)
      }
    }
  }

  await walk(root, '', null, 0)

  summary.removed = softDeleteMissing(db, libraryId, scanId, Date.now())
  deleteStaleFolders(db, libraryId, scanId)
  recomputeFolderCounts(db, libraryId)
  finishScan(db, libraryId, Date.now(), summary.files)
  return summary
}
