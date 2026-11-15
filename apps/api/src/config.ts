import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

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

export async function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Promise<ApiConfig> {
  const dataDir = path.resolve(env.DATA_DIR ?? 'data')
  const cacheDir = path.resolve(env.CACHE_DIR ?? 'cache')
  const mediaRoot = path.resolve(env.MEDIA_ROOT ?? 'sample-media')
  await mkdir(dataDir, { recursive: true })
  await mkdir(cacheDir, { recursive: true })

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
  }
}
