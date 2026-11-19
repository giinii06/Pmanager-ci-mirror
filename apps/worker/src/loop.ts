import path from 'node:path'
import {
  DEFAULT_JOB_LEASE_MS,
  cancelRunningJobWithFence,
  claimNextJob,
  completeJob,
  createDatabaseBackup,
  failJob,
  getLatestBackupLog,
  heartbeatJob,
  pauseRunningJobWithFence,
  pruneOldJobs,
  requeueInterruptedJobWithFence,
  type Db,
} from '@mediavault/database'
import { StructuredLogger } from '@mediavault/media'
import type { WorkerConfig } from './config'
import { runBulkLoop } from './bulk/worker'
import { executeJob } from './handlers'
import { classifyJobError } from './job-errors'
import { collectHlsGarbage } from './hls-maintenance'
import { runMutationLoop } from './mutations/worker'
import { runWorkerRecovery } from './recovery'
import { ScanInterruptedError } from './scan'
import { startMediaWatcher } from './watch'

const HEARTBEAT_INTERVAL_MS = 20_000
const RECOVERY_INTERVAL_MS = 15_000
const HLS_GC_INTERVAL_MS = 10 * 60_000
const BACKUP_INTERVAL_MS = 24 * 60 * 60_000
const JOB_RETENTION_MS = 14 * 24 * 60 * 60_000

export async function runWorker(db: Db, config: WorkerConfig): Promise<void> {
  const logger = new StructuredLogger(
    'worker',
    config.once ? undefined : path.join(config.dataDir, 'logs'),
  )

  const initialRecovery = await runWorkerRecovery(db, config, {
    reconcileThumbs: true,
    recordLog: true,
  })
  if (
    initialRecovery.recoveredJobs > 0 ||
    initialRecovery.repairedScans > 0 ||
    initialRecovery.cleanedTempFiles > 0 ||
    initialRecovery.requeuedThumbnails > 0
  ) {
    logger.info('worker.recovery.startup', {
      workerId: config.workerId,
      ...initialRecovery,
    })
  }

  const watcher = config.once ? null : startMediaWatcher(db, config)
  let stopping = false
  let activeController: AbortController | null = null
  const mutationController = new AbortController()
  const mutationLoop = config.once
    ? null
    : runMutationLoop(db, config, logger, mutationController.signal).catch((error) => {
        logger.error('worker.mutation_loop.crashed', { errorMessage: (error as Error).message })
      })
  const bulkController = new AbortController()
  const bulkLoop = config.once
    ? null
    : runBulkLoop(db, config, logger, bulkController.signal).catch((error) => {
        logger.error('worker.bulk_loop.crashed', { errorMessage: (error as Error).message })
      })
  const stop = () => {
    stopping = true
    activeController?.abort('shutdown')
    mutationController.abort('shutdown')
    bulkController.abort('shutdown')
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  let lastRecoveryCheck = Date.now()
  let lastBackupCheck = Date.now()
  let lastHlsGc = 0

  try {
    while (!stopping) {
      const now = Date.now()
      if (!config.once && now - lastRecoveryCheck >= RECOVERY_INTERVAL_MS) {
        lastRecoveryCheck = now
        const periodic = await runWorkerRecovery(db, config, {
          now,
          recordLog: false,
          reconcileThumbs: false,
        })
        if (periodic.recoveredJobs > 0) {
          logger.warn('worker.recovery.expired_leases', {
            recoveredJobs: periodic.recoveredJobs,
          })
        }
      }

      if (!config.once && now - lastHlsGc >= HLS_GC_INTERVAL_MS) {
        lastHlsGc = now
        try {
          const gc = await collectHlsGarbage(db, config.cacheDir, now)
          if (gc.removed > 0 || gc.orphaned > 0) {
            logger.info('worker.hls.gc', { removed: gc.removed, orphaned: gc.orphaned })
          }
        } catch (error) {
          logger.error('worker.hls.gc_failed', { errorMessage: (error as Error).message })
        }
      }

      if (!config.once && now - lastBackupCheck >= 60_000) {
        lastBackupCheck = now
        const latestBackup = getLatestBackupLog(db, true)
        if (!latestBackup || now - latestBackup.createdAt >= BACKUP_INTERVAL_MS) {
          try {
            const backupDir = path.join(config.dataDir, 'backups')
            const record = createDatabaseBackup(db, backupDir, { retentionCount: 14, now })
            pruneOldJobs(db, now - JOB_RETENTION_MS)
            logger.info('worker.backup.created', {
              backupId: record.id,
              filename: record.filename,
              sizeBytes: record.sizeBytes,
            })
          } catch (error) {
            logger.error('worker.backup.failed', {
              errorMessage: (error as Error).message,
            })
          }
        }
      }

      const job = claimNextJob(db, Date.now(), {
        workerId: config.workerId,
        leaseMs: DEFAULT_JOB_LEASE_MS,
      })
      if (!job) {
        if (config.once) return
        await Bun.sleep(config.pollMs)
        continue
      }

      const started = Date.now()
      const controller = new AbortController()
      activeController = controller
      const currentFence = () => ({
        workerId: config.workerId,
        leaseEpoch: job.leaseEpoch,
        now: Date.now(),
      })

      const hbTimer = setInterval(() => {
        const hb = heartbeatJob(db, job.id, currentFence(), DEFAULT_JOB_LEASE_MS)
        if (!hb.alive) {
          controller.abort('lease_lost')
          return
        }
        if (hb.cancelRequested) {
          controller.abort('cancelled')
          return
        }
        if (hb.pauseRequested) {
          controller.abort('paused')
        }
      }, HEARTBEAT_INTERVAL_MS)

      try {
        await executeJob(db, config, job, {
          signal: controller.signal,
          fence: {
            workerId: config.workerId,
            leaseEpoch: job.leaseEpoch,
            jobId: job.id,
            leaseMs: DEFAULT_JOB_LEASE_MS,
          },
        })
        const ok = completeJob(db, job.id, Date.now(), currentFence())
        if (!ok) {
          logger.warn('worker.job.stale_complete_ignored', {
            jobId: job.id,
            kind: job.kind,
            leaseEpoch: job.leaseEpoch,
          })
        } else {
          logger.info('worker.job.done', {
            jobId: job.id,
            kind: job.kind,
            durationMs: Date.now() - started,
          })
        }
      } catch (error) {
        if (error instanceof ScanInterruptedError) {
          const fence = currentFence()
          if (error.reason === 'paused') {
            pauseRunningJobWithFence(db, job.id, fence)
            logger.info('worker.job.paused', { jobId: job.id, kind: job.kind })
          } else if (error.reason === 'cancelled') {
            cancelRunningJobWithFence(db, job.id, fence)
            logger.info('worker.job.cancelled', { jobId: job.id, kind: job.kind })
          } else if (error.reason === 'lease_lost') {
            logger.warn('worker.job.lease_lost', { jobId: job.id, kind: job.kind })
          } else {
            requeueInterruptedJobWithFence(db, job.id, fence)
            logger.info('worker.job.shutdown_requeued', { jobId: job.id, kind: job.kind })
          }
        } else {
          const message = (error as Error).message.slice(0, 500)
          const errorCode = classifyJobError(error)
          failJob(db, job.id, message, Date.now(), currentFence(), errorCode)
          logger.warn('worker.job.failed', {
            jobId: job.id,
            kind: job.kind,
            errorCode,
            errorMessage: message,
          })
        }
      } finally {
        clearInterval(hbTimer)
        activeController = null
      }
    }
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    if (mutationLoop) await mutationLoop
    if (watcher) await watcher.close()
  }
}
