import { readdir, rm, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { recordCacheCleanupRun } from '@mediavault/database'
import {
  CACHE_TYPES,
  isBlockedSystemRelativePath,
  newId,
  type CacheCleanupPreviewDTO,
  type CacheCleanupResultDTO,
  type CacheInventoryDTO,
  type CacheType,
  type CacheTypeDTO,
} from '@mediavault/shared'
import { isTempDownloadFile } from '@mediavault/media'
import type { AppContext } from './context'

/** Temp leftovers and exports are only removed once this old. */
const CANDIDATE_AGE_MS = 24 * 60 * 60_000
const STAT_BATCH = 64

const TYPE_LABELS: Record<CacheType, string> = {
  thumbs: '썸네일',
  previews: '미리보기',
  hls: 'HLS',
  scenes: '장면 썸네일',
  scene_checkpoints: '장면 체크포인트',
  temp: '임시 파일',
  exports: '내보내기 파일',
}

/** HLS generations belong to the worker's GC and checkpoints are resumable work. */
const PROTECTED_TYPES = new Set<CacheType>(['hls', 'scene_checkpoints'])

interface ScannedFile {
  abs: string
  rel: string
  bytes: number
  mtimeMs: number
}

interface Aggregate {
  bytes: number
  files: number
  oldest: number | null
  newest: number | null
}

interface Candidate {
  abs: string
  type: CacheType
  bytes: number
  files: number
}

export interface CacheScan {
  inventory: CacheInventoryDTO
  candidates: Candidate[]
  cutoff: number
  protectedBytes: number
  generation: string
}

function emptyAggregate(): Aggregate {
  return { bytes: 0, files: 0, oldest: null, newest: null }
}

function isTempName(name: string): boolean {
  return name.startsWith('.mv-extract-') || name.includes('.tmp') || isTempDownloadFile(name)
}

async function walkFiles(root: string, relBase: string, out: ScannedFile[]): Promise<void> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }

  const files: Array<{ abs: string; rel: string }> = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const abs = path.join(root, entry.name)
    const rel = `${relBase}${entry.name}`
    if (entry.isDirectory()) {
      if (isBlockedSystemRelativePath(entry.name)) continue
      await walkFiles(abs, `${rel}/`, out)
      continue
    }
    if (entry.isFile()) files.push({ abs, rel })
  }

  for (let index = 0; index < files.length; index += STAT_BATCH) {
    const batch = files.slice(index, index + STAT_BATCH)
    await Promise.all(
      batch.map(async (file) => {
        try {
          const info = await stat(file.abs)
          out.push({ abs: file.abs, rel: file.rel, bytes: info.size, mtimeMs: info.mtimeMs })
        } catch {
          // Vanished between readdir and stat.
        }
      }),
    )
  }
}

function versionOf(name: string): number | null {
  const match = /^v(\d+)$/.exec(name)
  if (!match) return null
  const version = Number(match[1])
  return Number.isInteger(version) ? version : null
}

function topTypeOf(rel: string): CacheType | null {
  const top = rel.split('/')[0] ?? ''
  switch (top) {
    case 'thumbs':
      return 'thumbs'
    case 'previews':
      return 'previews'
    case 'hls':
      return 'hls'
    case 'scenes':
      return 'scenes'
    case 'scene-checkpoints':
      return 'scene_checkpoints'
    case 'tmp':
    case 'temp':
      return 'temp'
    default:
      return null
  }
}

/**
 * One walk of the cache root. A file is typed by its top directory unless its
 * own name marks it as a temp leftover, so a stray `.tmp` under `thumbs` is
 * counted where it will actually be cleaned from.
 */
export async function scanCache(ctx: AppContext): Promise<CacheScan> {
  const now = Date.now()
  const cutoff = now - CANDIDATE_AGE_MS
  const files: ScannedFile[] = []

  let entries: Dirent[] = []
  try {
    entries = await readdir(ctx.config.cacheDir, { withFileTypes: true })
  } catch {
    // A missing cache root has no inventory.
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (isBlockedSystemRelativePath(entry.name)) continue
    await walkFiles(path.join(ctx.config.cacheDir, entry.name), `${entry.name}/`, files)
  }

  const exportRoot = path.join(ctx.config.dataDir, 'exports')
  const exportFiles: ScannedFile[] = []
  await walkFiles(exportRoot, '', exportFiles)

  const aggregates = new Map<CacheType, Aggregate>()
  for (const type of CACHE_TYPES) aggregates.set(type, emptyAggregate())

  const versionDirs = new Map<
    string,
    { abs: string; type: CacheType; assetId: string; version: number; bytes: number; files: number }
  >()
  const sceneDirs = new Map<string, { abs: string; assetId: string; bytes: number; files: number }>()
  const tempFiles: Candidate[] = []
  const oldExports: Candidate[] = []

  const addAggregate = (type: CacheType, file: ScannedFile): void => {
    const agg = aggregates.get(type)!
    agg.bytes += file.bytes
    agg.files += 1
    agg.oldest = agg.oldest === null ? file.mtimeMs : Math.min(agg.oldest, file.mtimeMs)
    agg.newest = agg.newest === null ? file.mtimeMs : Math.max(agg.newest, file.mtimeMs)
  }

  for (const file of files) {
    const topType = topTypeOf(file.rel)
    if (!topType) continue
    const type = isTempName(path.basename(file.rel)) ? 'temp' : topType
    addAggregate(type, file)

    const parts = file.rel.split('/')
    if (type === 'temp') {
      if (file.mtimeMs <= cutoff) {
        tempFiles.push({ abs: file.abs, type, bytes: file.bytes, files: 1 })
      }
      continue
    }
    if (type === 'thumbs' || type === 'previews') {
      const assetId = parts[1]
      const version = versionOf(parts[2] ?? '')
      if (!assetId || version === null) continue
      const dirAbs = path.join(ctx.config.cacheDir, type, assetId, `v${version}`)
      const entry = versionDirs.get(dirAbs) ?? {
        abs: dirAbs,
        type,
        assetId,
        version,
        bytes: 0,
        files: 0,
      }
      entry.bytes += file.bytes
      entry.files += 1
      versionDirs.set(dirAbs, entry)
      continue
    }
    if (type === 'scenes') {
      const assetId = parts[1]
      if (!assetId) continue
      const dirAbs = path.join(ctx.config.cacheDir, 'scenes', assetId)
      const entry = sceneDirs.get(dirAbs) ?? { abs: dirAbs, assetId, bytes: 0, files: 0 }
      entry.bytes += file.bytes
      entry.files += 1
      sceneDirs.set(dirAbs, entry)
    }
  }

  for (const file of exportFiles) {
    addAggregate('exports', file)
    if (file.mtimeMs <= cutoff) {
      oldExports.push({ abs: file.abs, type: 'exports', bytes: file.bytes, files: 1 })
    }
  }

  const assets = new Map(
    ctx.db
      .query<{ id: string; fileVersion: number; deletedAt: number | null }, []>(
        'SELECT id, file_version AS fileVersion, deleted_at AS deletedAt FROM assets',
      )
      .all()
      .map((row) => [row.id, row]),
  )

  const candidates: Candidate[] = [...tempFiles, ...oldExports]
  for (const dir of versionDirs.values()) {
    const asset = assets.get(dir.assetId)
    if (!asset || asset.deletedAt !== null || asset.fileVersion !== dir.version) {
      candidates.push({
        abs: dir.abs,
        type: dir.type,
        bytes: dir.bytes,
        files: dir.files,
      })
    }
  }
  for (const dir of sceneDirs.values()) {
    const asset = assets.get(dir.assetId)
    if (!asset || asset.deletedAt !== null) {
      candidates.push({ abs: dir.abs, type: 'scenes', bytes: dir.bytes, files: dir.files })
    }
  }

  const types: CacheTypeDTO[] = CACHE_TYPES.map((type) => {
    const agg = aggregates.get(type)!
    return {
      type,
      bytes: agg.bytes,
      files: agg.files,
      oldestAt: agg.oldest !== null ? new Date(agg.oldest).toISOString() : null,
      newestAt: agg.newest !== null ? new Date(agg.newest).toISOString() : null,
      regenerable: type !== 'scene_checkpoints',
      protected: PROTECTED_TYPES.has(type),
    }
  })

  const totalBytes = types.reduce((sum, type) => sum + type.bytes, 0)
  const candidateBytes = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0)

  const hasher = new Bun.CryptoHasher('sha256')
  for (const candidate of [...candidates].sort((a, b) => a.abs.localeCompare(b.abs))) {
    hasher.update(`${candidate.type}\t${candidate.abs}\t${candidate.bytes}\t${candidate.files}\n`)
  }

  return {
    inventory: {
      computedAt: new Date(now).toISOString(),
      totalBytes,
      types,
    },
    candidates,
    cutoff,
    protectedBytes: Math.max(0, totalBytes - candidateBytes),
    generation: hasher.digest('hex').slice(0, 16),
  }
}

export function toCleanupPreview(scan: CacheScan): CacheCleanupPreviewDTO {
  const counts = new Map<CacheType, number>()
  for (const candidate of scan.candidates) {
    counts.set(candidate.type, (counts.get(candidate.type) ?? 0) + candidate.files)
  }
  const parts = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, files]) => `${TYPE_LABELS[type]} ${files}개`)
  const restoreCost =
    parts.length === 0
      ? '정리할 캐시가 없습니다. 원본과 격리 파일은 삭제되지 않습니다.'
      : `${parts.join(', ')}를 다시 생성하면 복원됩니다. 원본과 격리 파일은 삭제되지 않습니다.`

  return {
    generation: scan.generation,
    cutoff: new Date(scan.cutoff).toISOString(),
    types: [...counts.keys()].sort(),
    files: scan.candidates.reduce((sum, candidate) => sum + candidate.files, 0),
    bytes: scan.candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
    protectedBytes: scan.protectedBytes,
    restoreCost,
  }
}

function inside(root: string, target: string): boolean {
  const base = path.resolve(root)
  const resolved = path.resolve(target)
  return resolved.startsWith(base + path.sep)
}

export interface CacheCleanResult {
  result: CacheCleanupResultDTO
  /** False when the candidate set moved between preview and clean. */
  applied: boolean
}

/**
 * Deletes only the rows the preview listed. The generation covers the exact
 * candidate set, so a file that appeared or aged in between makes the call a
 * no-op instead of deleting something the operator never saw.
 */
export async function cleanCache(
  ctx: AppContext,
  input: { generation: string; types?: CacheType[]; userId: string | null },
): Promise<CacheCleanResult> {
  const scan = await scanCache(ctx)
  if (scan.generation !== input.generation) {
    return { result: { deletedFiles: 0, deletedBytes: 0, failed: 0 }, applied: false }
  }

  const wanted = input.types && input.types.length > 0 ? new Set(input.types) : null
  const selected = wanted
    ? scan.candidates.filter((candidate) => wanted.has(candidate.type))
    : scan.candidates

  let deletedFiles = 0
  let deletedBytes = 0
  let failed = 0
  for (const candidate of selected) {
    if (!inside(ctx.config.cacheDir, candidate.abs) && !inside(ctx.config.dataDir, candidate.abs)) {
      failed += 1
      continue
    }
    try {
      await rm(candidate.abs, { recursive: true, force: true })
      deletedFiles += candidate.files
      deletedBytes += candidate.bytes
    } catch {
      failed += 1
    }
  }

  const types = [...new Set(selected.map((candidate) => candidate.type))]
  recordCacheCleanupRun(ctx.db, {
    id: newId(16),
    userId: input.userId,
    types,
    candidateBytes: selected.reduce((sum, candidate) => sum + candidate.bytes, 0),
    deletedBytes,
    deletedFiles,
    now: Date.now(),
  })

  return { result: { deletedFiles, deletedBytes, failed }, applied: true }
}
