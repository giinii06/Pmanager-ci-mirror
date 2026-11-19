import { EventEmitter } from 'node:events'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import chokidar from 'chokidar'
import { enqueueJob, listLibraries, type Db } from '@mediavault/database'
import { isTempDownloadFile, resolveInside } from '@mediavault/media'
import { PRIORITY, classifyFile } from '@mediavault/shared'
import { enqueueArchivesInDir } from './archives'
import type { WorkerConfig } from './config'

const ARCHIVE_FILE_RE = /\.(rar|r\d{2,})$/i
const BLOCKED_WATCH_DIRS = new Set([
  '$recycle.bin',
  'system volume information',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'recovery',
  'appdata',
])
const WATCH_REFRESH_MS = 15_000

export interface MediaWatcher {
  once(event: 'ready', listener: () => void): unknown
  close(): Promise<void>
}

function findOwningLibrary(
  db: Db,
  mediaRoot: string,
  absFile: string,
): { libraryId: string; libRoot: string } | null {
  let best: { libraryId: string; libRoot: string } | null = null
  for (const lib of listLibraries(db)) {
    const libRoot = resolveInside(mediaRoot, lib.rootPath)
    if (!libRoot) continue
    const rel = path.relative(libRoot, absFile)
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      if (!best || libRoot.length > best.libRoot.length) {
        best = { libraryId: lib.id, libRoot }
      }
    }
  }
  return best
}

function collectLibraryRoots(db: Db, mediaRoot: string): string[] {
  const roots: string[] = []
  for (const lib of listLibraries(db)) {
    const abs = resolveInside(mediaRoot, lib.rootPath)
    if (abs) roots.push(abs)
  }
  return roots
}

function shouldSkipName(name: string): boolean {
  return name.startsWith('.') || BLOCKED_WATCH_DIRS.has(name.toLowerCase())
}

function isMediaSubMount(dirAbs: string, mediaRoot: string): boolean {
  const drivesMount = path.join(mediaRoot, 'drives')
  const extraMount = path.join(mediaRoot, 'extra')
  return (
    dirAbs === drivesMount ||
    dirAbs.startsWith(`${drivesMount}${path.sep}`) ||
    dirAbs === extraMount ||
    dirAbs.startsWith(`${extraMount}${path.sep}`)
  )
}

function createDirectoryMtimePoller(
  db: Db,
  config: WorkerConfig,
  handleFile: (absPath: string) => void,
  cleanupTimers: () => void,
): MediaWatcher {
  const emitter = new EventEmitter()
  const stableMs = config.archiveStableMs ?? 1_500
  const pollMs = Math.min(2_500, Math.max(150, stableMs * 2))
  const dirState = new Map<string, { rootDir: string; mtimeMs: number; files: Set<string> }>()
  const dirsWithTemp = new Set<string>()
  const pendingFiles = new Map<
    string,
    { size: number; mtimeMs: number; stableSince: number }
  >()
  let stopped = false
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let activePoll: Promise<void> | null = null

  const indexTree = async (startDir: string, rootDir: string, notifyNewFiles: boolean): Promise<void> => {
    const queue = [startDir]
    while (queue.length > 0 && !stopped) {
      const dir = queue.pop()!
      if (rootDir === config.mediaRoot && isMediaSubMount(dir, config.mediaRoot)) continue
      try {
        const [dirInfo, entries] = await Promise.all([
          stat(dir),
          readdir(dir, { withFileTypes: true }),
        ])
        if (!dirInfo.isDirectory()) continue
        const files = new Set<string>()
        let hasTemp = false
        for (const entry of entries) {
          if (entry.isSymbolicLink() || shouldSkipName(entry.name)) continue
          const childAbs = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            queue.push(childAbs)
            continue
          }
          if (!entry.isFile()) continue
          if (isTempDownloadFile(entry.name)) {
            hasTemp = true
            continue
          }
          files.add(entry.name)
          if (notifyNewFiles && (ARCHIVE_FILE_RE.test(entry.name) || classifyFile(entry.name))) {
            if (!pendingFiles.has(childAbs)) {
              const info = await stat(childAbs).catch(() => null)
              if (info?.isFile()) {
                const now = Date.now()
                pendingFiles.set(childAbs, {
                  size: info.size,
                  mtimeMs: info.mtimeMs,
                  stableSince: now,
                })
              }
            }
          }
        }
        dirState.set(dir, { rootDir, mtimeMs: dirInfo.mtimeMs, files })
        if (hasTemp) dirsWithTemp.add(dir)
        else dirsWithTemp.delete(dir)
      } catch {
        dirState.delete(dir)
        dirsWithTemp.delete(dir)
      }
    }
  }

  const pollOnce = async (): Promise<void> => {
    const roots = collectLibraryRoots(db, config.mediaRoot)

    for (const root of roots) {
      if (stopped) return
      if (!dirState.has(root)) {
        await indexTree(root, root, false)
      }
    }

    const dirs = Array.from(dirState.keys())
    let cursor = 0
    const concurrency = Math.min(16, Math.max(1, dirs.length))
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (!stopped && cursor < dirs.length) {
          const dir = dirs[cursor]!
          cursor += 1
          const prev = dirState.get(dir)
          if (!prev) continue
          if (
            !roots.some(
              (r) => dir === r || dir.startsWith(`${r}${path.sep}`),
            )
          ) {
            dirState.delete(dir)
            dirsWithTemp.delete(dir)
            continue
          }
          try {
            const info = await stat(dir)
            if (!info.isDirectory()) {
              dirState.delete(dir)
              continue
            }
            if (info.mtimeMs === prev.mtimeMs && !dirsWithTemp.has(dir)) continue

            const entries = await readdir(dir, { withFileTypes: true })
            const nextFiles = new Set<string>()
            let hasTemp = false
            for (const entry of entries) {
              if (entry.isSymbolicLink() || shouldSkipName(entry.name)) continue
              const childAbs = path.join(dir, entry.name)
              if (entry.isDirectory()) {
                if (!dirState.has(childAbs)) {
                  await indexTree(childAbs, prev.rootDir, true)
                }
                continue
              }
              if (!entry.isFile()) continue
              if (isTempDownloadFile(entry.name)) {
                hasTemp = true
                continue
              }
              nextFiles.add(entry.name)
              if (!prev.files.has(entry.name)) {
                if (ARCHIVE_FILE_RE.test(entry.name) || classifyFile(entry.name)) {
                  if (!pendingFiles.has(childAbs)) {
                    const fileInfo = await stat(childAbs).catch(() => null)
                    if (fileInfo?.isFile()) {
                      pendingFiles.set(childAbs, {
                        size: fileInfo.size,
                        mtimeMs: fileInfo.mtimeMs,
                        stableSince: Date.now(),
                      })
                    }
                  }
                }
              }
            }
            dirState.set(dir, { rootDir: prev.rootDir, mtimeMs: info.mtimeMs, files: nextFiles })
            if (hasTemp) dirsWithTemp.add(dir)
            else dirsWithTemp.delete(dir)
          } catch {
            dirState.delete(dir)
            dirsWithTemp.delete(dir)
          }
        }
      }),
    )

    const now = Date.now()
    for (const [absPath, tracked] of pendingFiles) {
      if (stopped) return
      const info = await stat(absPath).catch(() => null)
      if (!info?.isFile()) {
        pendingFiles.delete(absPath)
        continue
      }
      if (info.size !== tracked.size || info.mtimeMs !== tracked.mtimeMs) {
        pendingFiles.set(absPath, {
          size: info.size,
          mtimeMs: info.mtimeMs,
          stableSince: now,
        })
        continue
      }
      if (now - tracked.stableSince >= stableMs) {
        pendingFiles.delete(absPath)
        handleFile(absPath)
      }
    }
  }

  const runPoll = async () => {
    const task = pollOnce().catch((error) => {
      console.warn(`[watch] poll failed: ${(error as Error).message}`)
    })
    activePoll = task
    try {
      await task
    } finally {
      if (activePoll === task) activePoll = null
    }
  }

  const scheduleNext = () => {
    if (stopped) return
    pollTimer = setTimeout(() => {
      void runPoll().finally(scheduleNext)
    }, pollMs)
    pollTimer.unref?.()
  }

  const initialTask = (async () => {
    try {
      const roots = collectLibraryRoots(db, config.mediaRoot)
      for (const root of roots) {
        await indexTree(root, root, false)
      }
      if (!stopped) {
        emitter.emit('ready')
        scheduleNext()
      }
    } catch (error) {
      console.warn(`[watch] initial index failed: ${(error as Error).message}`)
    }
  })()
  activePoll = initialTask
  void initialTask.finally(() => {
    if (activePoll === initialTask) activePoll = null
  })

  return {
    once(event, listener) {
      emitter.once(event, listener)
      return emitter
    },
    async close() {
      stopped = true
      if (pollTimer !== null) clearTimeout(pollTimer)
      pollTimer = null
      cleanupTimers()
      if (activePoll) await activePoll
    },
  }
}

/**
 * Watches registered library roots for newly completed `.rar` archives and media
 * files, debouncing burst writes and skipping hidden or temp browser downloads.
 */
export function startMediaWatcher(db: Db, config: WorkerConfig): MediaWatcher {
  const archiveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const scanTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const cleanupTimers = () => {
    for (const timer of archiveTimers.values()) clearTimeout(timer)
    for (const timer of scanTimers.values()) clearTimeout(timer)
    archiveTimers.clear()
    scanTimers.clear()
  }

  const scheduleArchiveCheck = (libraryId: string, libRoot: string, dir: string, delayMs: number) => {
    const key = `${libraryId}:${dir}`
    const prev = archiveTimers.get(key)
    if (prev) clearTimeout(prev)
    archiveTimers.set(key, setTimeout(() => {
      archiveTimers.delete(key)
      void enqueueArchivesInDir(
        db, libraryId, libRoot, dir, PRIORITY.visible, Date.now(), undefined,
        (retryInMs) => scheduleArchiveCheck(libraryId, libRoot, dir, Math.max(retryInMs, 1_000)),
      ).catch((error) => {
        console.warn(`[watch] archive discovery failed in ${dir}: ${(error as Error).message}`)
      })
    }, delayMs))
  }

  const handleFile = (absPath: string) => {
    const name = path.basename(absPath)
    if (shouldSkipName(name) || isTempDownloadFile(name)) return
    const match = findOwningLibrary(db, config.mediaRoot, absPath)
    if (!match) return

    if (ARCHIVE_FILE_RE.test(name)) {
      scheduleArchiveCheck(match.libraryId, match.libRoot, path.dirname(absPath), 500)
      return
    }

    if (classifyFile(name)) {
      const prev = scanTimers.get(match.libraryId)
      if (prev) clearTimeout(prev)
      scanTimers.set(
        match.libraryId,
        setTimeout(() => {
          scanTimers.delete(match.libraryId)
          enqueueJob(
            db,
            {
              dedupeKey: `scan:${match.libraryId}`,
              kind: 'scan_library',
              priority: PRIORITY.visible,
              libraryId: match.libraryId,
            },
            Date.now(),
          )
        }, 1_000),
      )
    }
  }

  if (config.watchPolling) {
    return createDirectoryMtimePoller(db, config, handleFile, cleanupTimers)
  }

  const watchedRoots = new Set(collectLibraryRoots(db, config.mediaRoot))
  const drivesMount = path.join(config.mediaRoot, 'drives')
  const extraMount = path.join(config.mediaRoot, 'extra')

  const watcher = chokidar.watch(Array.from(watchedRoots), {
    ignoreInitial: true,
    followSymlinks: false,
    usePolling: false,
    ignored: (filePath: string) => {
      const base = path.basename(filePath)
      if (shouldSkipName(base) || isTempDownloadFile(base)) return true
      if (
        watchedRoots.has(config.mediaRoot) &&
        (filePath === drivesMount ||
          filePath.startsWith(`${drivesMount}${path.sep}`) ||
          filePath === extraMount ||
          filePath.startsWith(`${extraMount}${path.sep}`))
      ) {
        return true
      }
      return false
    },
    awaitWriteFinish: {
      stabilityThreshold: config.archiveStableMs ?? 1_500,
      pollInterval: 300,
    },
  })

  const syncRootsTimer = setInterval(() => {
    const desired = new Set(collectLibraryRoots(db, config.mediaRoot))
    for (const dir of desired) {
      if (!watchedRoots.has(dir)) {
        watchedRoots.add(dir)
        watcher.add(dir)
      }
    }
    for (const dir of Array.from(watchedRoots)) {
      if (!desired.has(dir)) {
        watchedRoots.delete(dir)
        void watcher.unwatch(dir)
      }
    }
  }, WATCH_REFRESH_MS)
  syncRootsTimer.unref()

  watcher.on('add', handleFile)
  watcher.on('change', handleFile)
  watcher.on('error', (error) => {
    console.warn(`[watch] error: ${(error as Error).message}`)
  })

  const origClose = watcher.close.bind(watcher)
  watcher.close = async () => {
    clearInterval(syncRootsTimer)
    cleanupTimers()
    await origClose()
  }

  return watcher
}
