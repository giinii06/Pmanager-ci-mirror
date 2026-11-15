import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

export interface AsrConfig {
  enabled: boolean
  workerToken: string
  resultDir: string
  modelRevision: string
  alignerRevision: string
  pipelineVersion: string
}

export interface ApiConfig {
  port: number
  host: string
  dataDir: string
  cacheDir: string
  mediaRoot: string
  authSecret: string
  accel: boolean
  hwaccel: 'nvenc' | null
  secureCookies: boolean
  asr: AsrConfig
}

async function resolveSecret(dataDir: string, fromEnv: string | undefined): Promise<string> {
  const provided = fromEnv?.trim()
  if (provided) return provided

  const file = path.join(dataDir, 'secret.key')
  try {
    const stored = (await readFile(file, 'utf8')).trim()
    if (stored.length >= 32) return stored
  } catch {
    // Generate below.
  }
  const secret = randomBytes(32).toString('hex')
  await writeFile(file, secret, { mode: 0o600 })
  return secret
}

function resolveAsr(env: Record<string, string | undefined>): AsrConfig {
  const token = env.ASR_WORKER_TOKEN?.trim() ?? ''
  const enabled = env.ASR_ENABLED ? env.ASR_ENABLED === '1' : token.length > 0
  if (enabled && token.length < 16) {
    throw new Error('ASR_WORKER_TOKEN must be at least 16 characters when ASR is enabled.')
  }

  return {
    enabled,
    workerToken: token,
    resultDir: path.resolve(env.ASR_RESULT_DIR ?? 'asr-results'),
    modelRevision: env.ASR_MODEL_REVISION?.trim() || 'main',
    alignerRevision: env.ALIGN_MODEL_REVISION?.trim() || 'main',
    pipelineVersion: env.ASR_PIPELINE_VERSION?.trim() || '1',
  }
}

export async function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Promise<ApiConfig> {
  const dataDir = path.resolve(env.DATA_DIR ?? 'data')
  const cacheDir = path.resolve(env.CACHE_DIR ?? 'cache')
  const mediaRoot = path.resolve(env.MEDIA_ROOT ?? 'sample-media')
  await mkdir(dataDir, { recursive: true })
  await mkdir(cacheDir, { recursive: true })

  const asr = resolveAsr(env)
  if (asr.enabled) await mkdir(asr.resultDir, { recursive: true })

  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '127.0.0.1',
    dataDir,
    cacheDir,
    mediaRoot,
    authSecret: await resolveSecret(dataDir, env.AUTH_SECRET),
    accel: env.MEDIA_ACCEL === 'nginx',
    hwaccel: env.HWACCEL === 'nvenc' ? 'nvenc' : null,
    secureCookies: env.COOKIE_SECURE === '1',
    asr,
  }
}
