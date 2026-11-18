import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
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

function collectLibraryRoots(db: Db, mediaRoot: string): string[] {
  const roots: string[] = []
  for (const lib of listLibraries(db)) {
    const abs = resolveInside(mediaRoot, lib.rootPath)
    if (abs) roots.push(abs)
  }
  return roots
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

/**
 * Watches `config.mediaRoot` for newly completed `.rar` archives and media files,
 * debouncing burst writes and skipping hidden or in-progress browser downloads.
 */
export function startMediaWatcher(db: Db, config: WorkerConfig): FSWatcher {
  const archiveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const scanTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const handleFile = (absPath: string) => {
    const name = path.basename(absPath)
    if (name.startsWith('.') || isTempDownloadFile(name)) return
    const match = findOwningLibrary(db, config.mediaRoot, absPath)
    if (!match) return

    if (ARCHIVE_FILE_RE.test(name)) {
      const dir = path.dirname(absPath)
      const key = `${match.libraryId}:${dir}`
      const prev = archiveTimers.get(key)
      if (prev) clearTimeout(prev)
      archiveTimers.set(
        key,
        setTimeout(() => {
          archiveTimers.delete(key)
          void enqueueArchivesInDir(
            db,
            match.libraryId,
            match.libRoot,
            dir,
            PRIORITY.visible,
          ).catch((error) => {
            console.warn(`[watch] archive discovery failed in ${dir}: ${(error as Error).message}`)
          })
        }, 500),
      )
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

  const watchedRoots = new Set(collectLibraryRoots(db, config.mediaRoot))
  const drivesMount = path.join(config.mediaRoot, 'drives')
  const extraMount = path.join(config.mediaRoot, 'extra')

  const watcher = chokidar.watch(Array.from(watchedRoots), {
    ignoreInitial: true,
    followSymlinks: false,
    usePolling: config.watchPolling ?? false,
    interval: 2_000,
    binaryInterval: 3_000,
    ignored: (filePath: string) => {
      const base = path.basename(filePath)
      const lower = base.toLowerCase()
      if (base.startsWith('.') || isTempDownloadFile(base) || BLOCKED_WATCH_DIRS.has(lower)) {
        return true
      }
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
    for (const timer of archiveTimers.values()) clearTimeout(timer)
    for (const timer of scanTimers.values()) clearTimeout(timer)
    archiveTimers.clear()
    scanTimers.clear()
    await origClose()
  }

  return watcher
}
