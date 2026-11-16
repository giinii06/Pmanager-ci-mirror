import path from 'node:path'
import { mkdir } from 'node:fs/promises'

export interface WorkerConfig {
  dataDir: string
  cacheDir: string
  mediaRoot: string
  hwaccel: 'nvenc' | null
  pollMs: number
  once: boolean
  /** The card ASR and translation workers also lease, so an encode collides with them. */
  gpuResource: string
  workerId: string
  /** A scan that would hide more than this share of a library is refused. */
  scanDeleteGuardRatio: number
  /** The operator's explicit override for a deletion the guard would refuse. */
  scanDeleteForce: boolean
}

export async function loadWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): Promise<WorkerConfig> {
  const dataDir = path.resolve(env.DATA_DIR ?? 'data')
  const cacheDir = path.resolve(env.CACHE_DIR ?? 'cache')
  const mediaRoot = path.resolve(env.MEDIA_ROOT ?? 'sample-media')
  await mkdir(dataDir, { recursive: true })
  await mkdir(cacheDir, { recursive: true })

  return {
    dataDir,
    cacheDir,
    mediaRoot,
    hwaccel: env.HWACCEL === 'nvenc' ? 'nvenc' : null,
    pollMs: Number(env.WORKER_POLL_MS ?? 500),
    once: env.WORKER_ONCE === '1',
    gpuResource: env.GPU_RESOURCE?.trim() || 'gpu:0',
    workerId: env.WORKER_ID?.trim() || `worker-${process.pid}`,
    scanDeleteGuardRatio: resolveGuardRatio(env.SCAN_DELETE_GUARD_RATIO),
    scanDeleteForce: env.SCAN_DELETE_FORCE === '1',
  }
}

function resolveGuardRatio(raw: string | undefined): number {
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.2
}
