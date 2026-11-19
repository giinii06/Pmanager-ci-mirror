import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
} from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
  unlink,
} from 'node:fs/promises'
import path from 'node:path'
import {
  clearAssetPendingMutation,
  ensureFolderPath,
  enqueueJob,
  findAssetForScan,
  getLibrary,
  getLibraryHealth,
  getMutationAsset,
  markAssetPendingMutation,
  recomputeFolderCounts,
  transitionMutation,
  updateAssetLocation,
  type Db,
  type FileMutationRecord,
  type MutationAssetRow,
} from '@mediavault/database'
import { PRIORITY } from '@mediavault/shared'
import { resolveInside } from '@mediavault/media'
import { MutationBlockedError, type MutationContext } from './delete'
import { isCrossDeviceRename, planQuarantine, quarantineAbs } from './quarantine'

interface MoveManifest {
  v: 2
  mode: 'move' | 'copy'
  file: { dev: number; ino: number; size: number; mtimeMs: number }
  target: { libraryId: string; root: string; rel: string }
  stagingRel: string
  quarantine: { root: string; rel: string } | null
  hash: string | null
  phase: 'planned' | 'copied'
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep)
}

function readManifest(mutation: FileMutationRecord): MoveManifest | null {
  if (!mutation.manifestJson) return null
  try {
    const parsed = JSON.parse(mutation.manifestJson) as MoveManifest
    if (parsed.v !== 2 || !parsed.target || !parsed.file) return null
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

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

async function fsyncFile(file: string): Promise<void> {
  const handle = await open(file, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function libraryAbs(root: string, mediaRoot: string): string | null {
  return resolveInside(mediaRoot, root)
}

function stagingAbs(manifest: MoveManifest, mediaRoot: string): string | null {
  const root = libraryAbs(manifest.target.root, mediaRoot)
  return root ? resolveInside(root, manifest.stagingRel) : null
}

function targetAbs(manifest: MoveManifest, mediaRoot: string): string | null {
  const root = libraryAbs(manifest.target.root, mediaRoot)
  return root ? resolveInside(root, manifest.target.rel) : null
}

function sourceAbs(asset: MutationAssetRow, mediaRoot: string): string | null {
  const root = libraryAbs(asset.libraryRoot, mediaRoot)
  return root ? resolveInside(root, asset.relativePath) : null
}

function quarantinePath(manifest: MoveManifest): string | null {
  if (!manifest.quarantine) return null
  return quarantineAbs(manifest.quarantine.root, manifest.quarantine.rel)
}

/**
 * Creates the destination directory without letting a symlinked component
 * redirect the write outside the library. The deepest existing ancestor is
 * resolved first, then the rest is created and re-checked.
 */
async function ensureTargetDir(targetRootAbs: string, targetRel: string): Promise<void> {
  const dirRel = path.posix.dirname(targetRel)
  const dirAbs = dirRel === '.' ? targetRootAbs : resolveInside(targetRootAbs, dirRel)
  if (!dirAbs) throw new MutationBlockedError('target_path_invalid', 'target path escapes the library')
  const realRoot = await realpath(targetRootAbs)
  let probe = dirAbs
  while (!(await pathExists(probe)) && probe !== targetRootAbs) {
    probe = path.dirname(probe)
  }
  const realProbe = await realpath(probe)
  if (!isWithin(realProbe, realRoot)) {
    throw new MutationBlockedError('target_outside_library', 'target directory resolves outside the library')
  }
  await mkdir(dirAbs, { recursive: true })
  const realDir = await realpath(dirAbs)
  if (!isWithin(realDir, realRoot)) {
    throw new MutationBlockedError('target_outside_library', 'target directory resolves outside the library')
  }
}

/** A target row that belongs to another asset is a conflict, not a merge. */
function assertTargetFree(
  db: Db,
  asset: MutationAssetRow,
  targetLibraryId: string,
  targetRel: string,
): void {
  if (asset.libraryId === targetLibraryId && asset.relativePath === targetRel) {
    throw new MutationBlockedError('target_same_as_source', 'the file is already at the target')
  }
  const existing = findAssetForScan(db, targetLibraryId, targetRel)
  if (!existing) return
  if (existing.id === asset.id) {
    throw new MutationBlockedError('target_same_as_source', 'the file is already at the target')
  }
  if (existing.deletedAt !== null) {
    throw new MutationBlockedError(
      'target_soft_deleted',
      'a soft-deleted asset still owns the target path',
    )
  }
  throw new MutationBlockedError('target_exists', 'another asset already owns the target path')
}

/**
 * Re-checks the destination directory right before the rename. `prepare` ran
 * the same check earlier, but a retry can be minutes later and a directory
 * component swapped for a symlink would otherwise redirect the write outside
 * the library. The check runs synchronously so it sits inside the transaction
 * that publishes the file.
 */
function assertTargetDirSafe(targetRootAbs: string, targetRel: string): void {
  const dirRel = path.posix.dirname(targetRel)
  const dirAbs = dirRel === '.' ? targetRootAbs : resolveInside(targetRootAbs, dirRel)
  if (!dirAbs) throw new MutationBlockedError('target_path_invalid', 'target path escapes the library')
  try {
    const realRoot = realpathSync(targetRootAbs)
    const realDir = realpathSync(dirAbs)
    if (!isWithin(realDir, realRoot)) {
      throw new MutationBlockedError(
        'target_outside_library',
        'target directory resolves outside the library',
      )
    }
  } catch (error) {
    if (error instanceof MutationBlockedError) throw error
    throw new MutationBlockedError('target_path_invalid', 'target directory is not reachable')
  }
}

/** A same-FS rename keeps the inode, which proves the target is our file. */
function targetIsRenamedSource(manifest: MoveManifest, target: string): boolean {
  try {
    const info = lstatSync(target)
    return (
      info.dev === manifest.file.dev &&
      info.ino === manifest.file.ino &&
      info.size === manifest.file.size &&
      Math.round(info.mtimeMs) === manifest.file.mtimeMs
    )
  } catch {
    return false
  }
}

/**
 * On resume the target may be the renamed source or the verified staging copy,
 * depending on where the crash landed. A recorded hash decides the copy case;
 * without one only the inode can prove the file.
 */
async function targetMatches(manifest: MoveManifest, target: string): Promise<boolean> {
  if (manifest.hash) return (await sha256File(target)) === manifest.hash
  return targetIsRenamedSource(manifest, target)
}

async function prepare(
  ctx: MutationContext,
  mutation: FileMutationRecord,
  asset: MutationAssetRow,
): Promise<void> {
  const { db, config } = ctx
  if (mutation.kind !== 'move' && mutation.kind !== 'copy') {
    throw new MutationBlockedError('unsupported_kind', `move engine cannot run ${mutation.kind}`)
  }
  if (!mutation.targetLibraryId || !mutation.targetRel) {
    throw new MutationBlockedError('target_missing', 'the mutation has no destination')
  }
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

  const libraryRoot = libraryAbs(asset.libraryRoot, config.mediaRoot)
  if (!libraryRoot) throw new MutationBlockedError('library_root_outside_media', 'library root escapes media')
  const source = resolveInside(libraryRoot, asset.relativePath)
  if (!source || source === libraryRoot) {
    throw new MutationBlockedError('source_path_invalid', 'asset path is not a file inside the library')
  }
  let realLibrary: string
  let realSource: string
  try {
    realLibrary = await realpath(libraryRoot)
    realSource = await realpath(source)
  } catch {
    throw new MutationBlockedError('source_missing', 'source file is not reachable')
  }
  if (!isWithin(realSource, realLibrary)) {
    throw new MutationBlockedError('source_outside_library', 'source resolves outside the library root')
  }
  const info = await lstat(source)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new MutationBlockedError('source_not_regular_file', 'source is not a regular file')
  }
  if (info.size !== asset.sizeBytes || Math.round(info.mtimeMs) !== asset.mtimeMs) {
    throw new MutationBlockedError('file_identity_mismatch', 'source size or mtime changed since indexing')
  }

  const targetLibrary = getLibrary(db, mutation.targetLibraryId)
  if (!targetLibrary) throw new MutationBlockedError('target_missing', 'target library no longer exists')
  const targetHealth = getLibraryHealth(db, targetLibrary.id)
  if (!targetHealth || targetHealth.state !== 'ONLINE') {
    throw new MutationBlockedError('target_offline', `target library is ${targetHealth?.state ?? 'UNVERIFIED'}`)
  }
  const targetRoot = libraryAbs(targetLibrary.rootPath, config.mediaRoot)
  if (!targetRoot) throw new MutationBlockedError('target_root_outside_media', 'target root escapes media')
  const target = resolveInside(targetRoot, mutation.targetRel)
  if (!target || target === targetRoot) {
    throw new MutationBlockedError('target_path_invalid', 'target path is not a file inside the library')
  }
  await ensureTargetDir(targetRoot, mutation.targetRel)
  assertTargetFree(db, asset, targetLibrary.id, mutation.targetRel)

  // A copy leaves the source untouched, so it does not need the scan fence.
  if (mutation.kind === 'move') {
    if (!markAssetPendingMutation(db, asset.id, mutation.id, asset.fileVersion, ctx.fence)) {
      throw new MutationBlockedError('asset_state_changed', 'asset changed while the move was prepared')
    }
  }

  const manifest: MoveManifest = {
    v: 2,
    mode: mutation.kind,
    file: {
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: Math.round(info.mtimeMs),
    },
    target: { libraryId: targetLibrary.id, root: targetLibrary.rootPath, rel: mutation.targetRel },
    stagingRel: `${mutation.targetRel}.${mutation.id}.tmp`,
    quarantine: null,
    hash: null,
    phase: 'planned',
  }
  const moved = transitionMutation(db, mutation.id, ctx.fence, {
    state: 'validated',
    manifestJson: JSON.stringify(manifest),
    event: { fileVersion: asset.fileVersion, targetLibraryId: targetLibrary.id },
  })
  if (!moved) {
    if (mutation.kind === 'move') clearAssetPendingMutation(db, asset.id, mutation.id)
    throw new Error('lease lost before validation was recorded')
  }
}

async function stageCopy(
  ctx: MutationContext,
  mutation: FileMutationRecord,
  asset: MutationAssetRow,
  manifest: MoveManifest,
): Promise<MoveManifest> {
  const source = sourceAbs(asset, ctx.config.mediaRoot)
  const staging = stagingAbs(manifest, ctx.config.mediaRoot)
  if (!source || !staging) {
    throw new MutationBlockedError('path_invalid', 'source or staging path is not usable')
  }
  await rm(staging, { force: true })
  await copyFile(source, staging)
  await fsyncFile(staging)
  const sourceHash = await sha256File(source)
  const copyHash = await sha256File(staging)
  const copyInfo = await lstat(staging)
  if (copyHash !== sourceHash || copyInfo.size !== manifest.file.size) {
    await rm(staging, { force: true })
    throw new MutationBlockedError('copy_verify_failed', 'the copy does not match the source')
  }

  const updated: MoveManifest = { ...manifest, hash: copyHash, phase: 'copied' }
  if (mutation.kind === 'move' && !updated.quarantine) {
    const plan = await planQuarantine(source, ctx.config.mediaRoot, mutation.id)
    if (!plan) {
      await rm(staging, { force: true })
      throw new MutationBlockedError('quarantine_unavailable', 'no same-volume quarantine location')
    }
    updated.quarantine = { root: plan.root, rel: plan.rel }
  }
  const recorded = transitionMutation(ctx.db, mutation.id, ctx.fence, {
    state: 'validated',
    quarantineRoot: updated.quarantine?.root ?? null,
    quarantineRel: updated.quarantine?.rel ?? null,
    manifestJson: JSON.stringify(updated),
    event: { copied: true, size: copyInfo.size },
  })
  if (!recorded) throw new Error('lease lost while recording the copy')
  return updated
}

/**
 * Publishes the new location and updates the asset row under one write lock.
 * The scanner cannot insert a row for the target while this transaction holds
 * the lock, and a crash before the commit leaves the source (or the verified
 * staging copy) in place for the resume path.
 */
function commitMove(
  ctx: MutationContext,
  mutation: FileMutationRecord,
  asset: MutationAssetRow,
  manifest: MoveManifest,
  options: { staging: string | null; quarantine: string | null; targetVerified?: boolean },
): void {
  const { db } = ctx
  const target = targetAbs(manifest, ctx.config.mediaRoot)
  const source = sourceAbs(asset, ctx.config.mediaRoot)
  const targetRoot = libraryAbs(manifest.target.root, ctx.config.mediaRoot)
  if (!target || !source || !targetRoot) {
    throw new MutationBlockedError('path_invalid', 'source or target path is not usable')
  }
  const targetLibrary = getLibrary(db, manifest.target.libraryId)
  if (!targetLibrary) throw new MutationBlockedError('target_missing', 'target library disappeared')

  let renamedTarget = false
  let renamedSource = false
  try {
    db.transaction(() => {
      assertTargetDirSafe(targetRoot, manifest.target.rel)
      assertTargetFree(db, asset, manifest.target.libraryId, manifest.target.rel)
      const folderRel = path.posix.dirname(manifest.target.rel)
      const folder = ensureFolderPath(db, {
        libraryId: manifest.target.libraryId,
        libraryName: targetLibrary.name,
        relativePath: folderRel === '.' ? '' : folderRel,
        scanId: `move:${mutation.id}`,
      })
      if (options.staging) {
        renameSync(options.staging, target)
        renamedTarget = true
      } else if (!existsSync(target)) {
        renameSync(source, target)
        renamedTarget = true
      } else if (!options.targetVerified && !targetIsRenamedSource(manifest, target)) {
        throw new MutationBlockedError('target_exists', 'the target path holds a different file')
      }
      if (options.quarantine) {
        mkdirSync(path.dirname(options.quarantine), { recursive: true, mode: 0o700 })
        renameSync(source, options.quarantine)
        renamedSource = true
      }
      if (
        !updateAssetLocation(db, asset.id, mutation.id, asset.fileVersion, {
          libraryId: manifest.target.libraryId,
          folderId: folder,
          relativePath: manifest.target.rel,
          filename: path.posix.basename(manifest.target.rel),
        })
      ) {
        throw new Error('asset location update was refused')
      }
    }).immediate()
  } catch (error) {
    // The transaction rolled back the database, not the filesystem. Put the
    // files back so a retry starts from a known state.
    let undoFailed = false
    if (renamedSource && options.quarantine) {
      try {
        renameSync(options.quarantine, source)
      } catch {
        undoFailed = true
      }
    }
    if (renamedTarget) {
      try {
        if (options.staging) renameSync(target, options.staging)
        else renameSync(target, source)
      } catch {
        undoFailed = true
      }
    }
    if (undoFailed) {
      throw new Error(
        `move commit failed and the filesystem could not be restored: ${(error as Error).message}`,
      )
    }
    throw error
  }
}

function publishCopy(
  ctx: MutationContext,
  mutation: FileMutationRecord,
  asset: MutationAssetRow,
  manifest: MoveManifest,
  staging: string,
): void {
  const { db } = ctx
  const target = targetAbs(manifest, ctx.config.mediaRoot)
  const targetRoot = libraryAbs(manifest.target.root, ctx.config.mediaRoot)
  if (!target || !targetRoot) {
    throw new MutationBlockedError('path_invalid', 'target path is not usable')
  }
  const targetLibrary = getLibrary(db, manifest.target.libraryId)
  if (!targetLibrary) throw new MutationBlockedError('target_missing', 'target library disappeared')

  let renamed = false
  try {
    db.transaction(() => {
      assertTargetDirSafe(targetRoot, manifest.target.rel)
      assertTargetFree(db, asset, manifest.target.libraryId, manifest.target.rel)
      if (existsSync(target)) {
        throw new MutationBlockedError('target_exists', 'the target path already holds a file')
      }
      renameSync(staging, target)
      renamed = true
    }).immediate()
  } catch (error) {
    if (renamed) {
      try {
        renameSync(target, staging)
      } catch {
        throw new Error(
          `copy publish failed and the staged file could not be restored: ${(error as Error).message}`,
        )
      }
    }
    throw error
  }
  enqueueScan(ctx, manifest.target.libraryId)
}

async function finishMove(
  ctx: MutationContext,
  mutation: FileMutationRecord,
  asset: MutationAssetRow,
  manifest: MoveManifest,
): Promise<void> {
  if (asset.libraryId !== manifest.target.libraryId) recomputeFolderCounts(ctx.db, asset.libraryId)
  recomputeFolderCounts(ctx.db, manifest.target.libraryId)

  const quarantine = quarantinePath(manifest)
  if (quarantine) {
    transitionMutation(ctx.db, mutation.id, ctx.fence, { state: 'purging' })
    try {
      await unlink(quarantine)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rm(path.dirname(quarantine), { recursive: true, force: true })
  }
  transitionMutation(ctx.db, mutation.id, ctx.fence, {
    state: 'completed',
    completedAt: ctx.fence.now,
    event: { targetRel: manifest.target.rel, targetLibraryId: manifest.target.libraryId },
  })
}

async function relocate(
  ctx: MutationContext,
  mutation: FileMutationRecord,
  asset: MutationAssetRow,
): Promise<void> {
  let manifest = readManifest(mutation)
  if (!manifest) throw new MutationBlockedError('manifest_missing', 'the move has no manifest')
  const source = sourceAbs(asset, ctx.config.mediaRoot)
  const target = targetAbs(manifest, ctx.config.mediaRoot)
  if (!source || !target) {
    throw new MutationBlockedError('path_invalid', 'source or target path is not usable')
  }

  // The database may already point at the target if the commit landed and the
  // state transition did not. That is a completed move, not a new one.
  if (asset.libraryId === manifest.target.libraryId && asset.relativePath === manifest.target.rel) {
    if (mutation.kind === 'copy') enqueueScan(ctx, manifest.target.libraryId)
    await finishMove(ctx, mutation, asset, manifest)
    return
  }

  const sourceExists = await pathExists(source)
  const targetExists = await pathExists(target)
  const staging = stagingAbs(manifest, ctx.config.mediaRoot)
  const stagingExists = staging ? await pathExists(staging) : false

  if (!sourceExists) {
    if (targetExists) {
      // The source was renamed or quarantined before the crash. The target can
      // be the renamed source or the verified copy, so the hash or the inode
      // decides whether the commit may proceed.
      if (!(await targetMatches(manifest, target))) {
        throw new MutationBlockedError('target_exists', 'the target path holds different bytes')
      }
      commitMove(ctx, mutation, asset, manifest, {
        staging: null,
        quarantine: null,
        targetVerified: true,
      })
      await finishMove(ctx, mutation, asset, manifest)
      return
    }
    throw new MutationBlockedError('source_missing', 'source file vanished before the move committed')
  }

  if (mutation.kind === 'copy') {
    if (targetExists) {
      if (!(await targetMatches(manifest, target))) {
        throw new MutationBlockedError('target_exists', 'the target path holds different bytes')
      }
      enqueueScan(ctx, manifest.target.libraryId)
      await finishMove(ctx, mutation, asset, manifest)
      return
    }
    if (!stagingExists || !manifest.hash) {
      manifest = await stageCopy(ctx, mutation, asset, manifest)
    }
    const staged = stagingAbs(manifest, ctx.config.mediaRoot)
    if (!staged) throw new MutationBlockedError('path_invalid', 'staging path is not usable')
    publishCopy(ctx, mutation, asset, manifest, staged)
    await finishMove(ctx, mutation, asset, manifest)
    return
  }

  // The target exists while the source is still present. Either a same-FS
  // rename committed without the database, or a verified copy was published
  // before the source could be quarantined. The identity check decides.
  if (targetExists) {
    if (!(await targetMatches(manifest, target))) {
      throw new MutationBlockedError('target_exists', 'the target path holds different bytes')
    }
    const plan = await planQuarantine(source, ctx.config.mediaRoot, mutation.id)
    if (!plan) throw new MutationBlockedError('quarantine_unavailable', 'no same-volume quarantine location')
    manifest = { ...manifest, quarantine: { root: plan.root, rel: plan.rel } }
    commitMove(ctx, mutation, asset, manifest, { staging: null, quarantine: plan.abs })
    await finishMove(ctx, mutation, asset, manifest)
    return
  }

  if (stagingExists && manifest.hash) {
    const plan = await planQuarantine(source, ctx.config.mediaRoot, mutation.id)
    if (!plan) throw new MutationBlockedError('quarantine_unavailable', 'no same-volume quarantine location')
    manifest = { ...manifest, quarantine: { root: plan.root, rel: plan.rel } }
    commitMove(ctx, mutation, asset, manifest, {
      staging: stagingAbs(manifest, ctx.config.mediaRoot),
      quarantine: plan.abs,
    })
    await finishMove(ctx, mutation, asset, manifest)
    return
  }

  // Try the cheap same-filesystem rename first. EXDEV is the only proof that a
  // copy is required, because two bind mounts of one disk share `st_dev`.
  try {
    commitMove(ctx, mutation, asset, manifest, { staging: null, quarantine: null })
    await finishMove(ctx, mutation, asset, manifest)
    return
  } catch (error) {
    if (!isCrossDeviceRename(error)) throw error
  }

  manifest = await stageCopy(ctx, mutation, asset, manifest)
  const quarantineAbsPath = quarantinePath(manifest)
  if (!quarantineAbsPath) {
    throw new MutationBlockedError('quarantine_unavailable', 'no same-volume quarantine location')
  }
  commitMove(ctx, mutation, asset, manifest, {
    staging: stagingAbs(manifest, ctx.config.mediaRoot),
    quarantine: quarantineAbsPath,
  })
  await finishMove(ctx, mutation, asset, manifest)
}

function enqueueScan(ctx: MutationContext, libraryId: string): void {
  enqueueJob(
    ctx.db,
    {
      dedupeKey: `scan:${libraryId}`,
      kind: 'scan_library',
      priority: PRIORITY.backlog,
      libraryId,
    },
    ctx.fence.now,
  )
}

async function purge(ctx: MutationContext, mutation: FileMutationRecord): Promise<void> {
  const manifest = readManifest(mutation)
  const quarantine = manifest ? quarantinePath(manifest) : null
  if (quarantine) {
    try {
      await unlink(quarantine)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rm(path.dirname(quarantine), { recursive: true, force: true })
  }
  transitionMutation(ctx.db, mutation.id, ctx.fence, {
    state: 'completed',
    completedAt: ctx.fence.now,
  })
}

export async function executeMoveMutation(
  ctx: MutationContext,
  mutation: FileMutationRecord,
): Promise<void> {
  const asset = mutation.assetId ? getMutationAsset(ctx.db, mutation.assetId) : null
  const step = mutation.state === 'failed_retryable' ? (mutation.resumeState ?? 'requested') : mutation.state
  try {
    if (step === 'requested') {
      if (!asset) throw new MutationBlockedError('asset_missing', 'asset no longer exists')
      return await prepare(ctx, mutation, asset)
    }
    if (step === 'validated') {
      if (!asset) throw new MutationBlockedError('asset_missing', 'asset no longer exists')
      return await relocate(ctx, mutation, asset)
    }
    if (step === 'quarantined') {
      if (!asset) throw new MutationBlockedError('asset_missing', 'asset no longer exists')
      const manifest = readManifest(mutation)
      if (!manifest) throw new MutationBlockedError('manifest_missing', 'the move has no manifest')
      return await finishMove(ctx, mutation, asset, manifest)
    }
    if (step === 'db_committed' || step === 'purging') {
      return await purge(ctx, mutation)
    }
    return
  } catch (error) {
    if (error instanceof MutationBlockedError) {
      if (mutation.assetId) clearAssetPendingMutation(ctx.db, mutation.assetId, mutation.id)
      transitionMutation(ctx.db, mutation.id, ctx.fence, {
        state: 'blocked',
        errorCode: error.code,
        errorMessage: error.message.slice(0, 500),
        event: { code: error.code },
      })
      ctx.logger.warn('mutation.move_blocked', {
        mutationId: mutation.id,
        code: error.code,
        message: error.message,
      })
      return
    }
    const message = (error as Error).message
    if (mutation.attempts >= mutation.maxAttempts) {
      if (mutation.assetId) clearAssetPendingMutation(ctx.db, mutation.assetId, mutation.id)
      transitionMutation(ctx.db, mutation.id, ctx.fence, {
        state: 'blocked',
        errorCode: 'retry_exhausted',
        errorMessage: message.slice(0, 500),
        event: { code: 'retry_exhausted' },
      })
      ctx.logger.warn('mutation.move_blocked', { mutationId: mutation.id, message })
      return
    }
    const backoff = Math.min(10 * 60_000, 30_000 * 2 ** Math.max(0, mutation.attempts - 1))
    transitionMutation(ctx.db, mutation.id, ctx.fence, {
      state: 'failed_retryable',
      resumeState: step,
      errorCode: 'move_failed',
      errorMessage: message.slice(0, 500),
      retryAfter: ctx.fence.now + backoff,
      event: { retryInMs: backoff },
    })
    ctx.logger.warn('mutation.move_retry', {
      mutationId: mutation.id,
      state: step,
      message: message.slice(0, 200),
    })
  }
}
