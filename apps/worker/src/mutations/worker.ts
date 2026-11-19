import {
  DEFAULT_MUTATION_LEASE_MS,
  claimNextMutation,
  heartbeatMutation,
  releaseMutationLease,
  type Db,
} from '@mediavault/database'
import type { WorkerConfig } from '../config'
import { executeDeleteMutation, type MutationLogger } from './delete'
import { executeMoveMutation } from './move'

/**
 * Runs beside the job loop in the same process. The lease makes it safe to
 * resume after a kill: a mutation is re-claimed only once its lease expires,
 * and every step is written to be idempotent from the state it resumes at.
 */
export async function runMutationLoop(
  db: Db,
  config: WorkerConfig,
  logger: MutationLogger,
  signal: AbortSignal,
): Promise<void> {
  if (!config.fileMutationEnabled) return
  const workerId = `${config.workerId}:mutation`
  const leaseMs = DEFAULT_MUTATION_LEASE_MS

  while (!signal.aborted) {
    const mutation = claimNextMutation(db, Date.now(), { workerId, leaseMs })
    if (!mutation) {
      await Bun.sleep(config.mutationPollMs ?? 1_000)
      continue
    }

    const fence = { workerId, leaseEpoch: mutation.leaseEpoch, now: Date.now() }
    const timer = setInterval(() => {
      fence.now = Date.now()
      heartbeatMutation(db, mutation.id, fence, leaseMs)
    }, Math.floor(leaseMs / 3))

    try {
      const ctx = { db, config, logger, fence }
      if (mutation.kind === 'move' || mutation.kind === 'copy') {
        await executeMoveMutation(ctx, mutation)
      } else {
        await executeDeleteMutation(ctx, mutation)
      }
    } finally {
      clearInterval(timer)
      fence.now = Date.now()
      releaseMutationLease(db, mutation.id, fence)
    }
  }
}
