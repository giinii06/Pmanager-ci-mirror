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
  /** A scan that would hide more than this many assets is refused. 0 disables the cap. */
  scanDeleteMaxAbsolute?: number
  /** How long archive files must stay unchanged before extraction starts. */
  archiveStableMs?: number
  /** Maximum wait for slow downloads to finish before failing archive stability. */
  archiveTimeoutMs?: number
  /** Enables polling for network/DrvFS mounts where inotify events do not cross from Windows. */
  watchPolling?: boolean
  /** Override minimum age for stale temp cleanup on recovery (ms). */
  staleTempAgeMs?: number
  /** Enables the quarantine delete engine. Off by default; the API reports 503 when off. */
  fileMutationEnabled?: boolean
  /** How often the mutation loop looks for work while idle. */
  mutationPollMs?: number
  /** Where ASR transcripts keep their result directories, for derived-data cleanup. */
  asrResultDir: string
  /** Where translations keep their result directories. */
  translationResultDir: string
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
    scanDeleteMaxAbsolute: resolveNonNegativeInt(env.SCAN_DELETE_MAX_ABSOLUTE, 0),
    archiveStableMs: resolveNonNegativeInt(env.ARCHIVE_STABLE_MS, 1_500),
    archiveTimeoutMs: resolveNonNegativeInt(env.ARCHIVE_TIMEOUT_MS, 15 * 60_000),
    watchPolling: env.WATCH_POLLING === '1',
    staleTempAgeMs: resolveNonNegativeInt(env.STALE_TEMP_AGE_MS, 2 * 60_000),
    fileMutationEnabled: env.FILE_MUTATION_ENGINE_ENABLED === '1',
    mutationPollMs: resolveNonNegativeInt(env.MUTATION_POLL_MS, 1_000),
    asrResultDir: path.resolve(env.ASR_RESULT_DIR ?? 'asr-results'),
    translationResultDir: path.resolve(env.TRANSLATION_RESULT_DIR ?? env.ASR_RESULT_DIR ?? 'asr-results'),
  }
}

function resolveNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback
}

function resolveGuardRatio(raw: string | undefined): number {
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.2
}
