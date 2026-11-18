import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { enqueueJob, listLibraries, type Db } from '@mediavault/database'
import { isTempDownloadFile, resolveInside } from '@mediavault/media'
import { PRIORITY, classifyFile } from '@mediavault/shared'
import { enqueueArchivesInDir } from './archives'
import type { WorkerConfig } from './config'

const ARCHIVE_FILE_RE = /\.(rar|r\d{2,})$/i

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

  const watcher = chokidar.watch(config.mediaRoot, {
    ignoreInitial: true,
    usePolling: config.watchPolling ?? false,
    interval: 2_000,
    binaryInterval: 3_000,
    ignored: (filePath: string) => {
      const base = path.basename(filePath)
      return base.startsWith('.') || isTempDownloadFile(base)
    },
    awaitWriteFinish: {
      stabilityThreshold: config.archiveStableMs ?? 1_500,
      pollInterval: 300,
    },
  })

  watcher.on('add', handleFile)
  watcher.on('change', handleFile)
  watcher.on('error', (error) => {
    console.warn(`[watch] error: ${(error as Error).message}`)
  })

  const origClose = watcher.close.bind(watcher)
  watcher.close = async () => {
    for (const timer of archiveTimers.values()) clearTimeout(timer)
    for (const timer of scanTimers.values()) clearTimeout(timer)
    archiveTimers.clear()
    scanTimers.clear()
    await origClose()
  }

  return watcher
}
