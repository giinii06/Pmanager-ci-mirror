import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { claimNextJob, createLibrary, openDatabase, type Db } from '@mediavault/database'
import type { WorkerConfig } from './config'
import { startMediaWatcher } from './watch'

const dirs: string[] = []
const dbs: Db[] = []

afterAll(async () => {
  for (const db of dbs) db.close()
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

describe('filesystem watcher for archives', () => {
  test(
    'with usePolling ignores .crdownload temp files and enqueues process_archive on .rar add',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'mv-watch-'))
      dirs.push(dir)
      const mediaRoot = path.join(dir, 'media')
      const setDir = path.join(mediaRoot, 'ModelA', 'WatchSet')
      await mkdir(setDir, { recursive: true })

      const db = openDatabase(':memory:')
      dbs.push(db)
      createLibrary(db, { id: 'lib1', name: 'ModelA', rootPath: 'ModelA', createdAt: 1 })

      const config: WorkerConfig = {
        dataDir: dir,
        cacheDir: path.join(dir, 'cache'),
        mediaRoot,
        hwaccel: null,
        pollMs: 50,
        once: false,
        gpuResource: 'gpu:0',
        workerId: 'w-watch',
        scanDeleteGuardRatio: 0.2,
        scanDeleteForce: false,
        archiveStableMs: 50,
        watchPolling: true,
      }

      const watcher = startMediaWatcher(db, config)
      try {
        await new Promise<void>((resolve) => {
          watcher.once('ready', () => resolve())
        })
        await Bun.sleep(150)

        const crdownloadPath = path.join(setDir, 'WatchSet.rar.crdownload')
        await writeFile(crdownloadPath, 'partial-download')
        await Bun.sleep(2_500)
        expect(claimNextJob(db, Date.now())).toBeNull()

        await rm(crdownloadPath)
        const rarPath = path.join(setDir, 'WatchSet.rar')
        await writeFile(rarPath, 'rar-bytes-ready')

        const deadline = Date.now() + 10_000
        let queued = null
        while (Date.now() < deadline) {
          queued = claimNextJob(db, Date.now())
          if (queued) break
          await Bun.sleep(100)
        }

        expect(queued?.kind).toBe('process_archive')
        expect(JSON.parse(queued!.payload!)).toMatchObject({
          libraryId: 'lib1',
          primaryPath: rarPath,
        })
      } finally {
        await watcher.close()
      }
    },
    20_000,
  )
})
