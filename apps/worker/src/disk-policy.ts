import { statfs } from 'node:fs/promises'
import type { JobKind } from '@mediavault/shared'
import type { WorkerConfig } from './config'

const POLICY_TTL_MS = 30_000

/** A cache write that would fail on ENOSPC is worse than a job that waits. */
const CACHE_WRITE_KINDS: JobKind[] = ['thumbnail', 'preview', 'hls']
const MEDIA_WRITE_KINDS: JobKind[] = ['process_archive']

export interface DiskPolicy {
  /** Kinds the claim must skip right now; empty when both volumes have headroom. */
  excludedKinds(now?: number): Promise<JobKind[]>
}

async function belowFloor(root: string, config: WorkerConfig): Promise<boolean> {
  try {
    const info = await statfs(root)
    const totalBytes = info.bsize * info.blocks
    const freeBytes = info.bsize * info.bavail
    const ratio = totalBytes > 0 ? freeBytes / totalBytes : 0
    return freeBytes < (config.minFreeBytes ?? 2 * 1024 ** 3) || ratio < (config.minFreeRatio ?? 0.1)
  } catch {
    // An unreadable volume is a different alert; it must not stall the queue.
    return false
  }
}

export function createDiskPolicy(config: WorkerConfig): DiskPolicy {
  let cache: { checkedAt: number; kinds: JobKind[] } | null = null

  return {
    async excludedKinds(now = Date.now()) {
      if (cache && now - cache.checkedAt < POLICY_TTL_MS) return cache.kinds

      const [cacheLow, mediaLow] = await Promise.all([
        belowFloor(config.cacheDir, config),
        belowFloor(config.mediaRoot, config),
      ])
      const kinds = [
        ...(cacheLow ? CACHE_WRITE_KINDS : []),
        ...(mediaLow ? MEDIA_WRITE_KINDS : []),
      ]
      cache = { checkedAt: now, kinds }
      return kinds
    },
  }
}
