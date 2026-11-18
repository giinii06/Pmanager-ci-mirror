import {
  claimNextJob,
  completeJob,
  failJob,
  recoverRunningJobs,
  type Db,
} from '@mediavault/database'
import type { WorkerConfig } from './config'
import { executeJob } from './handlers'
import { startMediaWatcher } from './watch'

export async function runWorker(db: Db, config: WorkerConfig): Promise<void> {
  const recovered = recoverRunningJobs(db, Date.now())
  if (recovered > 0) console.log(`[worker] requeued ${recovered} interrupted jobs`)

  const watcher = config.once ? null : startMediaWatcher(db, config)
  let stopping = false
  const stop = () => {
    stopping = true
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  try {
    while (!stopping) {
      const job = claimNextJob(db, Date.now())
      if (!job) {
        if (config.once) return
        await Bun.sleep(config.pollMs)
        continue
      }

      const started = Date.now()
      try {
        await executeJob(db, config, job)
        completeJob(db, job.id, Date.now())
        console.log(`[worker] ${job.kind} #${job.id} done in ${Date.now() - started}ms`)
      } catch (error) {
        const message = (error as Error).message.slice(0, 500)
        failJob(db, job.id, message, Date.now())
        console.warn(`[worker] ${job.kind} #${job.id} failed: ${message}`)
      }
    }
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    if (watcher) await watcher.close()
  }
}
