/**
 * End-to-end smoke test against a real API + worker process.
 *
 *   bun run smoke
 *
 * Generates a throwaway media folder in the OS temp dir, boots the API and the
 * worker on a private port, then exercises setup, library registration, scan,
 * thumbnails, range streaming, folders and stats over HTTP.
 */
import path from 'node:path'
import os from 'node:os'
import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises'
import sharp from 'sharp'

const PORT = Number(process.env.SMOKE_PORT ?? 8899)
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = path.resolve(import.meta.dir, '..')

const temp = await mkdtemp(path.join(os.tmpdir(), 'mediavault-smoke-'))
const mediaDir = path.join(temp, 'media')
const photosDir = path.join(mediaDir, 'Photos')
const dataDir = path.join(temp, 'data')
const cacheDir = path.join(temp, 'cache')

const children: Array<ReturnType<typeof Bun.spawn>> = []

function log(step: string, detail = ''): void {
  console.log(`  ok  ${step}${detail ? ` — ${detail}` : ''}`)
}

function fail(step: string, detail: string): never {
  console.error(`FAIL  ${step}\n${detail}`)
  process.exitCode = 1
  throw new Error(step)
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message, 'assertion failed')
}

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value !== null) return value
    } catch (error) {
      last = error
    }
    await Bun.sleep(200)
  }
  fail(label, `timed out after ${timeoutMs}ms${last ? `: ${String(last)}` : ''}`)
}

let cookie = ''

async function call(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${pathname}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  })
}

async function json<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const response = await call(pathname, init)
  if (!response.ok) {
    throw new Error(`${pathname} -> ${response.status} ${await response.text()}`)
  }
  return (await response.json()) as T
}

try {
  await mkdir(photosDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await mkdir(cacheDir, { recursive: true })

  const colors = ['#8b9eff', '#f0a45c', '#59c3a3']
  for (let index = 0; index < colors.length; index += 1) {
    const file = path.join(photosDir, `smoke-${index}.jpg`)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1067">
      <rect width="1600" height="1067" fill="${colors[index]}"/>
      <circle cx="800" cy="533" r="300" fill="rgba(255,255,255,0.35)"/>
    </svg>`
    await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toFile(file)
    const date = new Date(2026, 9, 20 - index, 9, 0, 0)
    await utimes(file, date, date)
  }

  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(PORT),
    MEDIA_ROOT: mediaDir,
    DATA_DIR: dataDir,
    CACHE_DIR: cacheDir,
    AUTH_SECRET: 'smoke-test-secret-value-0123456789',
    WORKER_POLL_MS: '100',
  }

  children.push(
    Bun.spawn(['bun', 'run', 'apps/api/src/index.ts'], {
      cwd: ROOT,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  )

  await waitFor('api health', async () => {
    const response = await fetch(`${BASE}/api/health`)
    return response.ok ? true : null
  })
  log('api listening', BASE)

  const setup = await call('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ username: 'smoke', password: 'smoke-password' }),
  })
  expect(setup.status === 201, `setup returned ${setup.status}`)
  cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  expect(cookie.startsWith('mv_session='), 'setup did not set a session cookie')
  log('account created')

  const library = await json<{ id: string; name: string; rootPath: string }>('/api/libraries', {
    method: 'POST',
    body: JSON.stringify({ name: 'Photos', rootPath: 'Photos' }),
  })
  log('library registered', library.id)

  children.push(
    Bun.spawn(['bun', 'run', 'apps/worker/src/index.ts'], {
      cwd: ROOT,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  )

  const scan = await call(`/api/libraries/${library.id}/scan`, { method: 'POST' })
  expect(scan.status === 202, `scan returned ${scan.status}`)

  const page = await waitFor('scan finished', async () => {
    const assets = await json<{ total: number; items: Array<{ id: string; filename: string }> }>(
      '/api/assets?limit=10',
    )
    const jobs = await json<{ counts: { queued: number; running: number } }>('/api/jobs')
    if (jobs.counts.queued === 0 && jobs.counts.running === 0 && assets.total >= 3) return assets
    return null
  })
  expect(page.total === 3, `expected 3 assets, got ${page.total}`)
  log('scan indexed 3 assets')

  const first = page.items[0]
  expect(first, 'no assets returned')

  const thumb = await call(`/api/assets/${first.id}/thumbnail?size=320`)
  expect(thumb.status === 200, `thumbnail returned ${thumb.status}`)
  expect(thumb.headers.get('content-type') === 'image/webp', 'thumbnail is not webp')
  const thumbBytes = (await thumb.arrayBuffer()).byteLength
  expect(thumbBytes > 500, `thumbnail too small (${thumbBytes} bytes)`)
  log('thumbnail served', `${thumbBytes} bytes`)

  const preview = await call(`/api/assets/${first.id}/preview`)
  expect(preview.status === 200, `preview returned ${preview.status}`)
  expect((await preview.arrayBuffer()).byteLength > 1_000, 'preview is empty')
  log('preview served')

  const stream = await call(`/api/assets/${first.id}/stream`, {
    headers: { range: 'bytes=0-99' },
  })
  expect(stream.status === 206, `range request returned ${stream.status}`)
  expect(stream.headers.get('content-range')?.startsWith('bytes 0-99/'), 'bad content-range')
  expect((await stream.arrayBuffer()).byteLength === 100, 'range body is not 100 bytes')
  log('range streaming works', stream.headers.get('content-range') ?? '')

  const folders = await json<Array<{ name: string; assetCount: number; coverAssetId: string | null }>>(
    '/api/folders',
  )
  expect(folders.length === 1, `expected 1 folder, got ${folders.length}`)
  expect(folders[0]?.assetCount === 3, `folder count is ${folders[0]?.assetCount}`)
  expect(Boolean(folders[0]?.coverAssetId), 'folder has no cover')
  log('folder counts and cover computed')

  const stats = await json<{ assets: number; images: number; videos: number }>('/api/stats')
  expect(stats.assets === 3 && stats.images === 3 && stats.videos === 0, 'stats mismatch')
  log('stats correct')

  const unauthorized = await fetch(`${BASE}/api/assets`)
  expect(unauthorized.status === 401, `unauthenticated request returned ${unauthorized.status}`)
  log('auth guard rejects anonymous requests')

  console.log('\nSmoke test passed.')
} catch (error) {
  if (process.exitCode !== 1) {
    console.error(error)
    process.exitCode = 1
  }
} finally {
  for (const child of children.reverse()) {
    child.kill()
  }
  await Promise.all(children.map((child) => child.exited))
  await rm(temp, { recursive: true, force: true })
}
