import { newId } from '@mediavault/shared'
import {
  pruneWorkerHeartbeats,
  recordWorkerHeartbeat,
  type Db,
  type WorkerHeartbeatRecord,
} from '@mediavault/database'
import type { WorkerConfig } from '../config'

const HEARTBEAT_INTERVAL_MS = 15_000
const HEARTBEAT_RETENTION_MS = 7 * 24 * 60 * 60_000

export interface HeartbeatHandle {
  setState(state: WorkerHeartbeatRecord['state'], jobId?: number | null): void
  stop(): void
}

/**
 * A row per boot. Docker keeps `worker_id` across restarts, so the instance id
 * is random; restart-loop detection counts distinct ids inside a window.
 */
export function startWorkerHeartbeat(db: Db, config: WorkerConfig): HeartbeatHandle {
  const instanceId = newId(16)
  const startedAt = Date.now()
  let state: WorkerHeartbeatRecord['state'] = 'idle'
  let currentJobId: number | null = null

  const write = (): void => {
    try {
      recordWorkerHeartbeat(db, {
        instanceId,
        workerId: config.workerId,
        component: 'worker',
        pid: process.pid,
        state,
        currentJobId,
        now: Date.now(),
      })
    } catch {
      // A heartbeat must never take the job loop down.
    }
  }

  write()
  const timer = setInterval(() => {
    write()
    pruneWorkerHeartbeats(db, Date.now() - HEARTBEAT_RETENTION_MS)
  }, HEARTBEAT_INTERVAL_MS)
  timer.unref()

  return {
    setState(next, jobId = null) {
      // The loop polls several times a second; only a real transition writes.
      if (next === state && jobId === currentJobId) return
      state = next
      currentJobId = jobId
      write()
    },
    stop() {
      clearInterval(timer)
      state = 'stopping'
      currentJobId = null
      write()
    },
  }
}
