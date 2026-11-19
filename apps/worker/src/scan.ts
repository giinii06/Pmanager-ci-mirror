import type { Dirent, Stats } from 'node:fs'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  clearScanCheckpoint,
  countAssets,
  countMissingAssets,
  createScanRun,
  deleteStaleFolders,
  enqueueJob,
  finishScan,
  getLibrary,
  getLibraryHealth,
  getScanCheckpoint,
  markLibraryFailure,
  markLibraryHealthy,
  preloadLibraryScanIndex,
  recomputeFolderCounts,
  reconcileContributions,
  reconcileVoteEvents,
  saveJobCheckpoint,
  setScanState,
  softDeleteMissing,
  touchAssets,
  updateAssetFile,
  updateScanProgress,
  updateScanRun,
  upsertFolder,
  upsertScanCheckpoint,
  insertAsset,
  type AssetFileUpdate,
  type Db,
  type LibraryHealthState,
  type NewAsset,
  type ScanAssetRow,
} from '@mediavault/database'
import { probeImage, probeVideo, resolveInside } from '@mediavault/media'
import {
  PRIORITY,
  classifyFile,
  extensionOf,
  isBlockedSystemRelativePath,
  isMountBoundaryRoot,
  newId,
} from '@mediavault/shared'
import { enqueueArchivesInDir } from './archives'
import type { WorkerConfig } from './config'

const BATCH_SIZE = 250
const STAT_CONCURRENCY = 16
const IMAGE_PROBE_CONCURRENCY = 16
const VIDEO_PROBE_CONCURRENCY = 4

const SKIP_DIRECTORIES = new Set(['@eaDir', '#recycle', 'lost+found'])

export interface ScanSummary {
  files: number
  added: number
  updated: number
  removed: number
  skipped: number
}

export interface ScanFenceContext {
  workerId: string
  leaseEpoch: number
  jobId: number
  leaseMs: number
}

export interface ScanOptions {
  fence?: ScanFenceContext
  signal?: AbortSignal
  onBatchCommitted?: (processedFiles: number) => void
}

export class ScanInterruptedError extends Error {
  constructor(
    public readonly reason: 'paused' | 'cancelled' | 'shutdown' | 'lease_lost',
    message = `scan interrupted (${reason})`,
  ) {
    super(message)
    this.name = 'ScanInterruptedError'
  }
}

export class ScanBlockedError extends Error {
  constructor(
    public readonly healthState: Exclude<LibraryHealthState, 'ONLINE'>,
    public readonly errorCode: string,
    message: string,
  ) {
    super(message)
    this.name = 'ScanBlockedError'
  }
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next
      next += 1
      results[idx] = await fn(items[idx]!)
    }
  })
  await Promise.all(workers)
  return results
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

interface PendingMutation {
  kind: 'insert' | 'update'
  relativePath: string
  asset?: NewAsset
  assetId?: string
  update?: AssetFileUpdate
  version: number
}

interface ProbeOutcome {
  relativePath: string
  filename: string
  folderId: string
  kind: 'image' | 'video'
  mimeType: string
  info: Stats
  existing: ScanAssetRow | undefined
  width: number | null
  height: number | null
  durationMs: number | null
  takenAt: number
  videoCodec: string | null
  audioCodec: string | null
  skipped: boolean
}

async function probeMediaWithRecheck(
  absPath: string,
  initialInfo: Stats,
  mediaKind: 'image' | 'video',
): Promise<{
  info: Stats
  width: number | null
  height: number | null
  durationMs: number | null
  takenAt: number
  videoCodec: string | null
  audioCodec: string | null
}> {
  let activeInfo = initialInfo
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const fallbackMs = activeInfo.mtimeMs
    const imageProbe = mediaKind === 'image' ? await probeImage(absPath, fallbackMs) : null
    const videoProbe = mediaKind === 'video' ? await probeVideo(absPath, fallbackMs) : null
    const after = await stat(absPath)
    const changedMidProbe =
      after.size !== activeInfo.size || Math.round(after.mtimeMs) !== Math.round(activeInfo.mtimeMs)
    if (!changedMidProbe) {
      if (videoProbe) {
        return {
          info: after,
          width: videoProbe.width,
          height: videoProbe.height,
          durationMs: videoProbe.durationMs,
          takenAt: videoProbe.takenAt,
          videoCodec: videoProbe.videoCodec,
          audioCodec: videoProbe.audioCodec,
        }
      }
      return {
        info: after,
        width: imageProbe!.width,
        height: imageProbe!.height,
        durationMs: null,
        takenAt: imageProbe!.takenAt,
        videoCodec: null,
        audioCodec: null,
      }
    }
    activeInfo = after
  }
  throw new Error(`file modified continuously during probe: ${absPath}`)
}

export async function scanLibrary(
  db: Db,
  config: WorkerConfig,
  libraryId: string,
  options: ScanOptions = {},
): Promise<ScanSummary> {
  const library = getLibrary(db, libraryId)
  if (!library) throw new Error(`library ${libraryId} no longer exists`)
  const root = resolveInside(config.mediaRoot, library.rootPath)
  if (!root) throw new Error(`library root escapes MEDIA_ROOT: ${library.rootPath}`)

  const health = getLibraryHealth(db, libraryId)
  const previousIdentity = health?.rootIdentity ?? null
  let rootIdentity: string | null = null
  const preTotal = countAssets(db, libraryId)
  const runRecordId = newId()
  const now = Date.now()
  const existingCheckpoint = getScanCheckpoint(db, libraryId)
  const resumedFromCheckpoint = Boolean(existingCheckpoint)
  const runScanId = existingCheckpoint?.scanId ?? `scan-${now}-${newId(6)}`
  const runStartedAt = existingCheckpoint?.startedAt ?? now

  createScanRun(db, {
    id: runRecordId,
    libraryId,
    rootPath: library.rootPath,
    phase: 'discover',
    status: 'running',
    resumedFromRunId: existingCheckpoint?.scanId ?? null,
    startedAt: now,
  })

  const blockScan = (
    reason: string,
    state: Exclude<LibraryHealthState, 'ONLINE'> = 'OFFLINE',
    errorCode = 'drive_unavailable',
    failureIdentity: string | null = rootIdentity,
  ): never => {
    const t = Date.now()
    updateScanRun(db, runRecordId, {
      phase: 'blocked',
      status: 'blocked',
      errorMessage: reason.slice(0, 500),
      mountIdentity: rootIdentity,
      healthState: state,
      completedAt: t,
      updatedAt: t,
    })
    markLibraryFailure(db, {
      libraryId,
      state,
      errorCode,
      now: t,
      rootIdentity: failureIdentity,
    })
    setScanState(db, libraryId, 'idle', reason.slice(0, 500))
    throw new ScanBlockedError(state, errorCode, reason)
  }

  let rootEntries: Dirent[]
  let identityChanged = false
  try {
    const rootLink = await lstat(root)
    if (rootLink.isSymbolicLink() || !rootLink.isDirectory()) {
      return blockScan(
        `drive_unavailable: ${library.rootPath} is not a real directory`,
        'OFFLINE',
        'root_not_directory',
      )
    }
    const realBase = await realpath(config.mediaRoot)
    const realRoot = await realpath(root)
    const relFromBase = path.relative(realBase, realRoot).replace(/\\/g, '/')
    if (
      relFromBase.startsWith('..') ||
      path.isAbsolute(relFromBase) ||
      isBlockedSystemRelativePath(relFromBase)
    ) {
      return blockScan(
        `drive_unavailable: ${library.rootPath} resolves outside allowed media directories`,
        'OFFLINE',
        'root_outside_media',
      )
    }
    const rootStat = await stat(root)
    rootIdentity = `${rootStat.dev}:${rootStat.ino}`
    identityChanged = previousIdentity !== null && previousIdentity !== rootIdentity
    rootEntries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    return blockScan(
      `drive_unavailable: cannot access ${library.rootPath} (${(error as Error).message})`,
      'OFFLINE',
      'root_unreadable',
    )
  }

  if (identityChanged) {
    return blockScan(
      `drive_identity_changed: ${library.rootPath} moved from ${previousIdentity} to ${rootIdentity}`,
      'DEGRADED',
      'root_identity_changed',
      null,
    )
  }

  if (isMountBoundaryRoot(library.rootPath) && rootEntries.length === 0 && preTotal > 0) {
    return blockScan(
      `drive_unavailable: mountpoint ${library.rootPath || '/media'} is empty while ${preTotal} assets exist`,
      'OFFLINE',
      'root_empty',
    )
  }

  updateScanRun(db, runRecordId, { mountIdentity: rootIdentity, updatedAt: Date.now() })

  const existingMap = preloadLibraryScanIndex(db, libraryId)
  const summary: ScanSummary = { files: 0, added: 0, updated: 0, removed: 0, skipped: 0 }
  const startedAtPerf = performance.now()
  let unchanged = 0
  let readErrors = 0
  let lastCommittedDirRel = existingCheckpoint?.lastDirRel ?? ''
  let lastCommittedRelPath = existingCheckpoint?.lastRelPath ?? ''

  let lastSeenDirRel = lastCommittedDirRel
  let lastSeenRelPath = lastCommittedRelPath
  let currentStage: 'index' | 'verify' = 'index'

  const touchBuffer: Array<{ id: string; rel: string }> = []
  const mutationBuffer: PendingMutation[] = []

  const flushBatch = (dirRel: string, relPath: string, activeScanId: string, saveCp: boolean): void => {
    if (touchBuffer.length === 0 && mutationBuffer.length === 0 && !saveCp) return
    const flushNow = Date.now()
    db.transaction(() => {
      if (touchBuffer.length > 0) {
        touchAssets(
          db,
          touchBuffer.map((t) => t.id),
          activeScanId,
        )
        for (const item of touchBuffer) {
          const entry = existingMap.get(item.rel)
          if (entry) {
            entry.deletedAt = null
            entry.lastSeenScan = activeScanId
          }
        }
      }

      for (const m of mutationBuffer) {
        if (m.kind === 'insert' && m.asset) {
          insertAsset(db, m.asset)
          enqueueJob(
            db,
            {
              dedupeKey: `thumbnail:${m.asset.id}:${m.version}`,
              kind: 'thumbnail',
              priority: PRIORITY.backlog,
              assetId: m.asset.id,
            },
            m.asset.indexedAt,
          )
          existingMap.set(m.relativePath, {
            id: m.asset.id,
            sizeBytes: m.asset.sizeBytes,
            mtimeMs: m.asset.mtimeMs,
            fileVersion: m.version,
            deletedAt: null,
            lastSeenScan: activeScanId,
          })
        } else if (m.kind === 'update' && m.assetId && m.update) {
          updateAssetFile(db, m.assetId, m.update)
          enqueueJob(
            db,
            {
              dedupeKey: `thumbnail:${m.assetId}:${m.version}`,
              kind: 'thumbnail',
              priority: PRIORITY.backlog,
              assetId: m.assetId,
            },
            m.update.indexedAt,
          )
          existingMap.set(m.relativePath, {
            id: m.assetId,
            sizeBytes: m.update.sizeBytes,
            mtimeMs: m.update.mtimeMs,
            fileVersion: m.version,
            deletedAt: null,
            lastSeenScan: activeScanId,
          })
        }
      }

      if (saveCp) {
        lastCommittedDirRel = dirRel
        lastCommittedRelPath = relPath
        upsertScanCheckpoint(db, {
          libraryId,
          scanId: runScanId,
          startedAt: runStartedAt,
          lastDirRel: dirRel,
          lastRelPath: relPath,
          processedFiles: summary.files,
          totalEstimate: null,
          updatedAt: flushNow,
        })
        updateScanProgress(db, libraryId, summary.files)
        if (options.fence) {
          const saved = saveJobCheckpoint(
            db,
            options.fence.jobId,
            {
              workerId: options.fence.workerId,
              leaseEpoch: options.fence.leaseEpoch,
              now: flushNow,
            },
            {
              checkpoint: JSON.stringify({
                scanId: runScanId,
                lastDirRel: dirRel,
                processedFiles: summary.files,
              }),
              progressCurrent: summary.files,
              phase: activeScanId === runScanId ? 'index' : 'verify',
            },
          )
          if (!saved) {
            throw new ScanInterruptedError('lease_lost', 'lost job lease while saving checkpoint')
          }
        }
      }
    }).immediate()

    touchBuffer.length = 0
    mutationBuffer.length = 0
    if (saveCp) options.onBatchCommitted?.(summary.files)
  }

  const checkInterrupted = (): void => {
    if (!options.signal?.aborted) return
    const reason =
      options.signal.reason === 'paused' ||
      options.signal.reason === 'cancelled' ||
      options.signal.reason === 'lease_lost'
        ? options.signal.reason
        : 'shutdown'
    throw new ScanInterruptedError(reason)
  }

  const shouldSkipCrossMountChild = (relative: string, childName: string): boolean => {
    if (library.rootPath !== '' || relative !== '') return false
    return childName === 'extra' || childName === 'drives'
  }

  const processDirectoryFiles = async (
    dirAbs: string,
    dirRel: string,
    folderId: string,
    entries: Dirent[],
    activeScanId: string,
    allowFastSkip: boolean,
  ): Promise<void> => {
    if (allowFastSkip) return

    const fileCandidates: Array<{
      name: string
      abs: string
      rel: string
      type: NonNullable<ReturnType<typeof classifyFile>>
    }> = []

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink() || !entry.isFile()) continue
      const type = classifyFile(entry.name)
      if (!type) continue
      const rel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`
      fileCandidates.push({
        name: entry.name,
        abs: path.join(dirAbs, entry.name),
        rel,
        type,
      })
    }

    const statResults = await mapPool(fileCandidates, STAT_CONCURRENCY, async (candidate) => {
      try {
        const info = await stat(candidate.abs)
        if (!info.isFile()) return { candidate, info: null, failed: false }
        return { candidate, info, failed: false }
      } catch {
        return { candidate, info: null, failed: true }
      }
    })

    const imageJobs: typeof statResults = []
    const videoJobs: typeof statResults = []

    for (const res of statResults) {
      if (res.failed) {
        readErrors += 1
        continue
      }
      if (!res.info) continue
      const mtimeMs = Math.round(res.info.mtimeMs)
      const existing = existingMap.get(res.candidate.rel)

      if (
        existing &&
        existing.deletedAt === null &&
        existing.sizeBytes === res.info.size &&
        existing.mtimeMs === mtimeMs
      ) {
        touchBuffer.push({ id: existing.id, rel: res.candidate.rel })
        lastSeenDirRel = dirRel
        lastSeenRelPath = res.candidate.rel
        unchanged += 1
        summary.files += 1
        if (touchBuffer.length + mutationBuffer.length >= BATCH_SIZE) {
          flushBatch(dirRel, res.candidate.rel, activeScanId, currentStage === 'index')
        }
        continue
      }

      if (res.candidate.type.kind === 'image') imageJobs.push(res)
      else videoJobs.push(res)
    }

    const probeOne = async (
      item: (typeof statResults)[number],
      mediaKind: 'image' | 'video',
    ): Promise<ProbeOutcome> => {
      const existing = existingMap.get(item.candidate.rel)
      try {
        const probed = await probeMediaWithRecheck(item.candidate.abs, item.info!, mediaKind)
        return {
          relativePath: item.candidate.rel,
          filename: item.candidate.name,
          folderId,
          kind: mediaKind,
          mimeType: item.candidate.type.mimeType,
          info: probed.info,
          existing,
          width: probed.width,
          height: probed.height,
          durationMs: probed.durationMs,
          takenAt: probed.takenAt,
          videoCodec: probed.videoCodec,
          audioCodec: probed.audioCodec,
          skipped: false,
        }
      } catch (error) {
        console.warn(`[scan] skipped ${item.candidate.rel}: ${(error as Error).message}`)
        return {
          relativePath: item.candidate.rel,
          filename: item.candidate.name,
          folderId,
          kind: mediaKind,
          mimeType: item.candidate.type.mimeType,
          info: item.info!,
          existing,
          width: null,
          height: null,
          durationMs: null,
          takenAt: item.info!.mtimeMs,
          videoCodec: null,
          audioCodec: null,
          skipped: true,
        }
      }
    }

    const [imageOutcomes, videoOutcomes] = await Promise.all([
      mapPool(imageJobs, IMAGE_PROBE_CONCURRENCY, (item) => probeOne(item, 'image')),
      mapPool(videoJobs, VIDEO_PROBE_CONCURRENCY, (item) => probeOne(item, 'video')),
    ])

    const outcomes = [...imageOutcomes, ...videoOutcomes].sort((a, b) =>
      compareNames(a.relativePath, b.relativePath),
    )

    for (const outcome of outcomes) {
      if (outcome.skipped) {
        if (outcome.existing) {
          touchBuffer.push({ id: outcome.existing.id, rel: outcome.relativePath })
          lastSeenDirRel = dirRel
          lastSeenRelPath = outcome.relativePath
        }
        summary.skipped += 1
        if (touchBuffer.length + mutationBuffer.length >= BATCH_SIZE) {
          flushBatch(dirRel, outcome.relativePath, activeScanId, currentStage === 'index')
        }
        continue
      }

      const indexedAt = Date.now()
      const mtimeMs = Math.round(outcome.info.mtimeMs)
      const container = extensionOf(outcome.filename)

      if (outcome.existing) {
        mutationBuffer.push({
          kind: 'update',
          relativePath: outcome.relativePath,
          assetId: outcome.existing.id,
          version: outcome.existing.fileVersion + 1,
          update: {
            folderId: outcome.folderId,
            filename: outcome.filename,
            mimeType: outcome.mimeType,
            sizeBytes: outcome.info.size,
            mtimeMs,
            width: outcome.width,
            height: outcome.height,
            durationMs: outcome.durationMs,
            takenAt: outcome.takenAt,
            videoCodec: outcome.videoCodec,
            audioCodec: outcome.audioCodec,
            container,
            indexedAt,
            scanId: activeScanId,
          },
        })
        summary.updated += 1
      } else {
        const assetId = newId()
        mutationBuffer.push({
          kind: 'insert',
          relativePath: outcome.relativePath,
          version: 1,
          asset: {
            id: assetId,
            libraryId,
            folderId: outcome.folderId,
            relativePath: outcome.relativePath,
            filename: outcome.filename,
            kind: outcome.kind,
            mimeType: outcome.mimeType,
            sizeBytes: outcome.info.size,
            mtimeMs,
            width: outcome.width,
            height: outcome.height,
            durationMs: outcome.durationMs,
            takenAt: outcome.takenAt,
            videoCodec: outcome.videoCodec,
            audioCodec: outcome.audioCodec,
            container,
            indexedAt,
            scanId: activeScanId,
          },
        })
        summary.added += 1
      }
      lastSeenDirRel = dirRel
      lastSeenRelPath = outcome.relativePath
      summary.files += 1

      if (touchBuffer.length + mutationBuffer.length >= BATCH_SIZE) {
        flushBatch(dirRel, outcome.relativePath, activeScanId, currentStage === 'index')
      }
    }
  }

  const walkTree = async (
    abs: string,
    rel: string,
    parentId: string | null,
    depth: number,
    activeScanId: string,
    checkpointCursorDir: string | null,
    prefetchedEntries?: Dirent[],
  ): Promise<void> => {
    checkInterrupted()

    const entries = prefetchedEntries ?? (await readdir(abs, { withFileTypes: true }))
    entries.sort((a, b) => compareNames(a.name, b.name))

    const folderId = upsertFolder(db, {
      id: newId(),
      libraryId,
      parentId,
      relativePath: rel,
      name: rel === '' ? library.name : path.basename(abs),
      depth,
      scanId: activeScanId,
    })

    let dirMtimeMs = Number.POSITIVE_INFINITY
    if (checkpointCursorDir !== null && rel < checkpointCursorDir) {
      try {
        dirMtimeMs = Math.round((await stat(abs)).mtimeMs)
      } catch {
        readErrors += 1
      }
    }

    const canFastSkipDir =
      checkpointCursorDir !== null &&
      rel !== '' &&
      rel < checkpointCursorDir &&
      dirMtimeMs <= runStartedAt

    await processDirectoryFiles(abs, rel, folderId, entries, activeScanId, canFastSkipDir)
    await enqueueArchivesInDir(db, libraryId, root, abs, PRIORITY.backlog, Date.now(), entries)

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink() || !entry.isDirectory()) continue
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      if (shouldSkipCrossMountChild(rel, entry.name)) continue
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (isBlockedSystemRelativePath(childRel)) continue
      const childAbs = path.join(abs, entry.name)
      await walkTree(childAbs, childRel, folderId, depth + 1, activeScanId, checkpointCursorDir)
    }
  }

  const runResumedVerificationPass = async (): Promise<string> => {
    const verifyScanId = `verify-${Date.now()}-${newId(6)}`
    currentStage = 'verify'
    summary.files = 0
    unchanged = 0
    updateScanRun(db, runRecordId, {
      phase: 'verify',
      status: 'running',
      updatedAt: Date.now(),
    })
    await walkTree(root, '', null, 0, verifyScanId, null)
    flushBatch(lastSeenDirRel, lastSeenRelPath, verifyScanId, false)
    return verifyScanId
  }

  try {
    currentStage = 'index'
    updateScanRun(db, runRecordId, { phase: 'index', status: 'running', updatedAt: Date.now() })
    await walkTree(
      root,
      '',
      null,
      0,
      runScanId,
      resumedFromCheckpoint ? lastCommittedDirRel : null,
      rootEntries,
    )
    flushBatch(lastSeenDirRel, lastSeenRelPath, runScanId, true)

    const authoritativeScanId = resumedFromCheckpoint ? await runResumedVerificationPass() : runScanId

    checkInterrupted()
    if (readErrors > 0) {
      return blockScan(
        `refusing deletion reconciliation after ${readErrors} filesystem read errors`,
        'DEGRADED',
        'read_errors',
      )
    }

    updateScanRun(db, runRecordId, { phase: 'reconcile', status: 'running', updatedAt: Date.now() })

    const total = countAssets(db, libraryId)
    const missing = countMissingAssets(db, libraryId, authoritativeScanId)
    const missingRatio = total === 0 ? 0 : missing / total
    const threshold = Math.floor(total * config.scanDeleteGuardRatio)
    const maxAbsolute = config.scanDeleteMaxAbsolute ?? 0
    const totalLoss = total > 0 && missing >= total
    const exceedsRatio = missing > threshold
    const exceedsAbsolute = maxAbsolute > 0 && missing > maxAbsolute

    if (totalLoss) {
      console.warn(
        JSON.stringify({
          event: 'scan.delete_guard',
          reason: 'total_loss',
          libraryId,
          total,
          missing,
        }),
      )
      return blockScan(
        `refusing to soft-delete ${missing} of ${total} assets: the root is empty or replaced`,
        'DEGRADED',
        'root_total_loss',
      )
    }

    if (missing > 0 && !config.scanDeleteForce && (exceedsRatio || exceedsAbsolute)) {
      console.warn(
        JSON.stringify({
          event: 'scan.delete_guard',
          libraryId,
          total,
          missing,
          missingRatio,
          threshold,
          maxAbsolute,
        }),
      )
      return blockScan(
        `refusing to soft-delete ${missing} of ${total} assets; set SCAN_DELETE_FORCE=1 to allow it`,
        'DEGRADED',
        'delete_guard',
      )
    }

    updateScanRun(db, runRecordId, { phase: 'finalize', status: 'running', updatedAt: Date.now() })
    const completedAt = Date.now()
    db.transaction(() => {
      summary.removed = softDeleteMissing(db, libraryId, authoritativeScanId, completedAt)
      deleteStaleFolders(db, libraryId, authoritativeScanId)
      recomputeFolderCounts(db, libraryId)
      reconcileContributions(db)
      reconcileVoteEvents(db)
      clearScanCheckpoint(db, libraryId)
      finishScan(db, libraryId, completedAt, summary.files)
      markLibraryHealthy(db, { libraryId, rootIdentity, now: completedAt })
      updateScanRun(db, runRecordId, {
        phase: 'completed',
        status: 'completed',
        filesSeen: summary.files,
        filesAdded: summary.added,
        filesUpdated: summary.updated,
        filesSkipped: summary.skipped,
        filesRemoved: summary.removed,
        readErrors,
        mountIdentity: rootIdentity,
        missingCount: missing,
        missingRatio,
        authoritativeVerified: 1,
        healthState: 'ONLINE',
        completedAt,
        updatedAt: completedAt,
      })
    }).immediate()

    console.info(
      JSON.stringify({
        event: 'scan.summary',
        files: summary.files,
        unchanged,
        durationMs: Math.round(performance.now() - startedAtPerf),
        removed: summary.removed,
        resumedFromCheckpoint,
      }),
    )
    return summary
  } catch (error) {
    if (error instanceof ScanBlockedError) throw error
    const t = Date.now()
    if (error instanceof ScanInterruptedError) {
      if (
        (error.reason === 'paused' || error.reason === 'shutdown') &&
        currentStage === 'index' &&
        (touchBuffer.length > 0 || mutationBuffer.length > 0)
      ) {
        flushBatch(lastSeenDirRel, lastSeenRelPath, runScanId, true)
      }
      if (error.reason === 'lease_lost') {
        markLibraryFailure(db, {
          libraryId,
          state: 'DEGRADED',
          errorCode: 'lease_lost',
          now: t,
          rootIdentity,
        })
        updateScanRun(db, runRecordId, {
          phase: 'failed',
          status: 'failed',
          filesSeen: summary.files,
          filesAdded: summary.added,
          filesUpdated: summary.updated,
          filesSkipped: summary.skipped,
          readErrors,
          errorMessage: error.message.slice(0, 500),
          healthState: 'DEGRADED',
          completedAt: t,
          updatedAt: t,
        })
      } else {
        const status = error.reason === 'cancelled' ? 'cancelled' : 'paused'
        updateScanRun(db, runRecordId, {
          phase: status,
          status,
          filesSeen: summary.files,
          filesAdded: summary.added,
          filesUpdated: summary.updated,
          filesSkipped: summary.skipped,
          readErrors,
          errorMessage: error.message,
          ...(error.reason === 'cancelled' ? { completedAt: t } : {}),
          updatedAt: t,
        })
      }
    } else {
      markLibraryFailure(db, {
        libraryId,
        state: 'DEGRADED',
        errorCode: 'scan_failed',
        now: t,
        rootIdentity,
      })
      updateScanRun(db, runRecordId, {
        phase: 'failed',
        status: 'failed',
        filesSeen: summary.files,
        filesAdded: summary.added,
        filesUpdated: summary.updated,
        filesSkipped: summary.skipped,
        readErrors,
        errorMessage: (error as Error).message.slice(0, 500),
        healthState: 'DEGRADED',
        completedAt: t,
        updatedAt: t,
      })
    }
    throw error
  }
}
