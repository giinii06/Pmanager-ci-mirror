import {
  acquireGpuLease,
  heartbeatGpuLease,
  releaseGpuLease,
  type Db,
} from '@mediavault/database'

const POLL_MS = 500

export interface GpuLease {
  heartbeat(): boolean
  release(): void
}

export interface GpuLeaseOptions {
  resourceId: string
  owner: string
  taskKind: string
  waitMs: number
  leaseMs: number
}

function hold(db: Db, options: GpuLeaseOptions): GpuLease {
  return {
    heartbeat: () =>
      heartbeatGpuLease(db, options.resourceId, options.owner, options.leaseMs, Date.now()),
    release: () => {
      releaseGpuLease(db, options.resourceId, options.owner)
    },
  }
}

async function waitForLease(db: Db, options: GpuLeaseOptions): Promise<GpuLease | null> {
  const deadline = Date.now() + options.waitMs
  for (;;) {
    const acquired = acquireGpuLease(
      db,
      {
        resourceId: options.resourceId,
        owner: options.owner,
        taskKind: options.taskKind,
        leaseMs: options.leaseMs,
      },
      Date.now(),
    )
    if (acquired) return hold(db, options)
    if (Date.now() >= deadline) return null
    await Bun.sleep(POLL_MS)
  }
}

/**
 * Runs `run` with the card held when the lease is free, and with `held` false
 * when another consumer keeps it past `waitMs`, so the caller can take a slower
 * path instead of blocking. `signal` aborts when the lease is lost, which is how
 * a long encode learns the card now belongs to another consumer.
 */
export async function withGpuLease<T>(
  db: Db,
  options: GpuLeaseOptions,
  run: (held: boolean, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const lease = await waitForLease(db, options)
  if (!lease) return run(false, controller.signal)

  const timer = setInterval(() => {
    if (lease.heartbeat()) return
    console.warn(`[gpu] lost the ${options.resourceId} lease for ${options.owner}`)
    clearInterval(timer)
    controller.abort()
  }, Math.max(1, Math.floor(options.leaseMs / 3)))

  try {
    return await run(true, controller.signal)
  } catch (error) {
    if (!controller.signal.aborted) throw error
    throw new Error(`the ${options.resourceId} lease was lost, so the work was stopped`, {
      cause: error,
    })
  } finally {
    clearInterval(timer)
    lease.release()
  }
}
