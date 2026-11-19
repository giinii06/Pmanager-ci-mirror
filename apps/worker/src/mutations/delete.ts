import path from 'node:path'
import { lstat, mkdir, realpath, rename, rm, unlink } from 'node:fs/promises'
import {
  clearAssetPendingDelete,
  commitPermanentDelete,
  getAssetDeletePlan,
  getLibraryHealth,
  getMutationAsset,
  markAssetPendingDelete,
  transitionMutation,
  type Db,
  type FileMutationRecord,
  type FileMutationState,
  type MutationLeaseFence,
} from '@mediavault/database'
import { resolveInside } from '@mediavault/media'
import type { WorkerConfig } from '../config'
import { isCrossDeviceRename, planQuarantine, quarantineAbs } from './quarantine'

export interface MutationLogger {
  info: (event: string, payload: Record<string, unknown>) => void
  warn: (event: string, payload: Record<string, unknown>) => void
  error: (event: string, payload: Record<string, unknown>) => void
}

export interface MutationContext {
  db: Db
  config: WorkerConfig
  logger: MutationLogger
  fence: MutationLeaseFence
}

/** A permanent refusal: retrying cannot help until a human or a rescan changes the world. */
export class MutationBlockedError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

interface CachePlan {
  assetId: string
  thumbs: string
  previews: string
  hls: string
  sceneThumbs: string[]
  asrDirs: string[]
  translationDirs: string[]
}

interface DeleteManifest {
  v: 1
  file: { dev: number; ino: number; size: number; mtimeMs: number }
  cache: CachePlan
}

const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 10 * 60_000

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep)
}

function readManifest(mutation: FileMutationRecord): DeleteManifest | null {
  if (!mutation.manifestJson) return null
  try {
    const parsed = JSON.parse(mutation.manifestJson) as DeleteManifest
    if (parsed.v !== 1 || !parsed.file) return null
    return parsed
  } catch {
    return null
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
}

function quarantinePath(mutation: FileMutationRecord): string | null {
  if (!mutation.quarantineRoot || !mutation.quarantineRel) return null
  return quarantineAbs(mutation.quarantineRoot, mutation.quarantineRel)
}

function sourcePath(db: Db, mutation: FileMutationRecord, mediaRoot: string): string | null {
  if (!mutation.assetId) return null
  const asset = getMutationAsset(db, mutation.assetId)
  if (!asset) return null
  const libraryRoot = resolveInside(mediaRoot, asset.libraryRoot)
  if (!libraryRoot) return null
  return resolveInside(libraryRoot, asset.relativePath)
}

async function buildCachePlan(db: Db, assetId: string): Promise<CachePlan> {
  const plan = getAssetDeletePlan(db, assetId)
  return {
    assetId,
    thumbs: path.join('thumbs', assetId),
    previews: path.join('previews', assetId),
    hls: path.join('hls', assetId),
    sceneThumbs: plan.sceneThumbPaths,
    asrDirs: plan.asrResultDirs,
    translationDirs: plan.translationResultDirs,
  }
}

async function rmDirInside(baseDir: string, rel: string, errors: string[]): Promise<void> {
  const target = resolveInside(baseDir, rel)
  if (!target || path.resolve(target) === path.resolve(baseDir)) return
  try {
    await rm(target, { recursive: true, force: true })
  } catch (error) {
    errors.push(`${rel}: ${(error as Error).message}`)
  }
}

async function unlinkInside(baseDir: string, target: string, errors: string[]): Promise<void> {
  const rel = path.relative(baseDir, target)
  const resolved = resolveInside(baseDir, rel)
  if (!resolved || path.resolve(resolved) === path.resolve(baseDir)) return
  try {
    await unlink(resolved)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    errors.push(`${rel}: ${(error as Error).message}`)
  }
}

async function purgeCaches(config: WorkerConfig, cache: CachePlan): Promise<string[]> {
  const errors: string[] = []
  await Promise.all([
    rmDirInside(config.cacheDir, cache.thumbs, errors),
    rmDirInside(config.cacheDir, cache.previews, errors),
    rmDirInside(config.cacheDir, cache.hls, errors),
    ...cache.sceneThumbs.map((p) => unlinkInside(config.cacheDir, p, errors)),
    ...cache.asrDirs.map((dir) =>
      rmDirInside(config.asrResultDir, path.relative(config.asrResultDir, dir), errors),
    ),
    ...cache.translationDirs.map((dir) =>
      rmDirInside(config.translationResultDir, path.relative(config.translationResultDir, dir), errors),
    ),
  ])
  return errors
}

async function rollbackTombstone(ctx: MutationContext, mutation: FileMutationRecord): Promise<void> {
  if (!mutation.assetId) return
  const qAbs = quarantinePath(mutation)
  if (qAbs && (await pathExists(qAbs))) return
  clearAssetPendingDelete(ctx.db, mutation.assetId, mutation.id)
}

async function block(
  ctx: MutationContext,
  mutation: FileMutationRecord,
  code: string,
  message: string,
): Promise<void> {
  transitionMutation(ctx.db, mutation.id, ctx.fence, {
    state: 'blocked',
    errorCode: code,
    errorMessage: message.slice(0, 500),
    event: { code },
  })
  await rollbackTombstone(ctx, mutation)
}

async function retryLater(
  ctx: MutationContext,
  mutation: FileMutationRecord,
  resumeState: FileMutationState,
  code: string,
  message: string,
): Promise<void> {
  if (mutation.attempts >= mutation.maxAttempts) {
    await block(ctx, mutation, 'retry_exhausted', `${code}: ${message}`)
    return
  }
  const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, mutation.attempts - 1))
  transitionMutation(ctx.db, mutation.id, ctx.fence, {
    state: 'failed_retryable',
    resumeState,
    errorCode: code,
    errorMessage: message.slice(0, 500),
    retryAfter: ctx.fence.now + backoff,
    event: { code, retryInMs: backoff },
  })
}

async function prepare(ctx: MutationContext, mutation: FileMutationRecord): Promise<void> {
  const { db, config } = ctx
  if (!mutation.assetId) throw new MutationBlockedError('asset_missing', 'mutation has no asset')
  const asset = getMutationAsset(db, mutation.assetId)
  if (!asset) throw new MutationBlockedError('asset_missing', 'asset no longer exists')
  if (asset.pendingDeleteMutationId && asset.pendingDeleteMutationId !== mutation.id) {
    throw new MutationBlockedError('asset_owned_by_other_mutation', 'another mutation owns this asset')
  }
  if (asset.deletedAt !== null) {
    throw new MutationBlockedError('asset_already_deleted', 'asset is already soft-deleted')
  }
  if (mutation.requestedFileVersion !== null && asset.fileVersion !== mutation.requestedFileVersion) {
    throw new MutationBlockedError('file_version_conflict', 'asset file version changed')
  }
  const health = getLibraryHealth(db, asset.libraryId)
  if (!health || health.state !== 'ONLINE') {
    throw new MutationBlockedError('source_offline', `library is ${health?.state ?? 'UNVERIFIED'}`)
  }

  const libraryRoot = resolveInside(config.mediaRoot, asset.libraryRoot)
  if (!libraryRoot) throw new MutationBlockedError('library_root_outside_media', 'library root escapes media')
  const sourceAbs = resolveInside(libraryRoot, asset.relativePath)
  if (!sourceAbs || sourceAbs === libraryRoot) {
    throw new MutationBlockedError('source_path_invalid', 'asset path is not a file inside the library')
  }

  let realLibrary: string
  let realSource: string
  try {
    realLibrary = await realpath(libraryRoot)
    realSource = await realpath(sourceAbs)
  } catch {
    throw new MutationBlockedError('source_missing', 'source file is not reachable')
  }
  if (!isWithin(realSource, realLibrary)) {
    throw new MutationBlockedError('source_outside_library', 'source resolves outside the library root')
  }

  const info = await lstat(sourceAbs)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new MutationBlockedError('source_not_regular_file', 'source is not a regular file')
  }
  if (info.size !== asset.sizeBytes || Math.round(info.mtimeMs) !== asset.mtimeMs) {
    throw new MutationBlockedError('file_identity_mismatch', 'source size or mtime changed since indexing')
  }

  const plan = await planQuarantine(realSource, config.mediaRoot, mutation.id)
  if (!plan) {
    throw new MutationBlockedError('quarantine_unavailable', 'no writable same-volume quarantine location')
  }

  const cache = await buildCachePlan(db, asset.id)
  const manifest: DeleteManifest = {
    v: 1,
    file: {
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: Math.round(info.mtimeMs),
    },
    cache,
  }

  if (!markAssetPendingDelete(db, asset.id, mutation.id, asset.fileVersion, ctx.fence)) {
    throw new MutationBlockedError('asset_state_changed', 'asset changed while the mutation was prepared')
  }

  const moved = transitionMutation(db, mutation.id, ctx.fence, {
    state: 'validated',
    quarantineRoot: plan.root,
    quarantineRel: plan.rel,
    manifestJson: JSON.stringify(manifest),
    originalDeletedAt: asset.deletedAt,
    event: { fileVersion: asset.fileVersion },
  })
  if (!moved) {
    clearAssetPendingDelete(db, asset.id, mutation.id)
    throw new Error('lease lost before validation was recorded')
  }
}

async function quarantine(ctx: MutationContext, mutation: FileMutationRecord): Promise<void> {
  const manifest = readManifest(mutation)
  if (!manifest) throw new MutationBlockedError('manifest_missing', 'mutation has no manifest')
  const qAbs = quarantinePath(mutation)
  if (!qAbs) throw new MutationBlockedError('quarantine_path_invalid', 'quarantine path is not usable')

  if (!(await pathExists(qAbs))) {
    const sourceAbs = sourcePath(ctx.db, mutation, ctx.config.mediaRoot)
    if (!sourceAbs) throw new MutationBlockedError('source_path_invalid', 'source path is not usable')
    let realSource: string
    try {
      realSource = await realpath(sourceAbs)
    } catch {
      throw new MutationBlockedError('source_missing', 'source file vanished before quarantine')
    }
    const info = await lstat(sourceAbs)
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new MutationBlockedError('source_not_regular_file', 'source is not a regular file')
    }
    if (info.size !== manifest.file.size || Math.round(info.mtimeMs) !== manifest.file.mtimeMs) {
      throw new MutationBlockedError('file_identity_mismatch', 'source changed before quarantine')
    }
    await mkdir(path.dirname(qAbs), { recursive: true, mode: 0o700 })
    try {
      await rename(realSource, qAbs)
    } catch (error) {
      if (isCrossDeviceRename(error)) {
        throw new MutationBlockedError('cross_device_rename', 'quarantine is not on the source filesystem')
      }
      throw error
    }
  }

  const qInfo = await lstat(qAbs)
  if (!qInfo.isFile()) throw new MutationBlockedError('quarantine_not_file', 'quarantined entry is not a file')

  transitionMutation(ctx.db, mutation.id, ctx.fence, {
    state: 'quarantined',
    manifestJson: JSON.stringify({
      ...manifest,
      file: {
        dev: qInfo.dev,
        ino: qInfo.ino,
        size: qInfo.size,
        mtimeMs: Math.round(qInfo.mtimeMs),
      },
    }),
    event: { size: qInfo.size },
  })
}

async function commit(ctx: MutationContext, mutation: FileMutationRecord): Promise<void> {
  const qAbs = quarantinePath(mutation)
  if (!qAbs) throw new MutationBlockedError('quarantine_path_invalid', 'quarantine path is not usable')
  if (!(await pathExists(qAbs))) {
    throw new MutationBlockedError('quarantine_lost', 'quarantined file is missing before commit')
  }
  if (!mutation.assetId || !mutation.libraryId) {
    throw new MutationBlockedError('asset_missing', 'mutation lost its asset reference')
  }

  const removed = commitPermanentDelete(ctx.db, mutation.assetId, mutation.libraryId, mutation.id)
  const stillThere = getMutationAsset(ctx.db, mutation.assetId)
  if (stillThere) {
    throw new MutationBlockedError('asset_commit_conflict', 'asset row survived the commit or changed owner')
  }

  transitionMutation(ctx.db, mutation.id, ctx.fence, {
    state: 'db_committed',
    event: { removed },
  })
}

async function purge(ctx: MutationContext, mutation: FileMutationRecord): Promise<void> {
  const manifest = readManifest(mutation)
  const qAbs = quarantinePath(mutation)
  if (!qAbs) throw new MutationBlockedError('quarantine_path_invalid', 'quarantine path is not usable')

  if (mutation.state !== 'purging') {
    transitionMutation(ctx.db, mutation.id, ctx.fence, { state: 'purging' })
  }

  const cacheErrors = manifest ? await purgeCaches(ctx.config, manifest.cache) : []
  try {
    await unlink(qAbs)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await rm(path.dirname(qAbs), { recursive: true, force: true })
  } catch {}

  transitionMutation(ctx.db, mutation.id, ctx.fence, {
    state: 'completed',
    completedAt: ctx.fence.now,
    event: { cacheErrors: cacheErrors.length },
  })
}

export async function executeDeleteMutation(
  ctx: MutationContext,
  mutation: FileMutationRecord,
): Promise<void> {
  const step = mutation.state === 'failed_retryable' ? (mutation.resumeState ?? 'requested') : mutation.state
  try {
    if (step === 'requested') return await prepare(ctx, mutation)
    if (step === 'validated') return await quarantine(ctx, mutation)
    if (step === 'quarantined') return await commit(ctx, mutation)
    if (step === 'db_committed' || step === 'purging') return await purge(ctx, mutation)
    return
  } catch (error) {
    if (error instanceof MutationBlockedError) {
      await block(ctx, mutation, error.code, error.message)
      ctx.logger.warn('mutation.blocked', {
        mutationId: mutation.id,
        code: error.code,
        message: error.message,
      })
      return
    }
    const message = (error as Error).message
    await retryLater(ctx, mutation, step, 'mutation_failed', message)
    ctx.logger.warn('mutation.retry', {
      mutationId: mutation.id,
      state: step,
      message: message.slice(0, 200),
    })
  }
}
