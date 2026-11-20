import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createLibrary,
  createUser,
  getNotification,
  insertAsset,
  listCacheCleanupRuns,
  listDiagnosticsRuns,
  openDatabase,
  upsertNotification,
  upsertFolder,
  type Db,
} from '@mediavault/database'
import type { CacheCleanupPreviewDTO, CacheInventoryDTO, DiagnosticsReportDTO } from '@mediavault/shared'
import { buildApp } from './app'
import { SESSION_COOKIE, createSession } from './auth'
import type { ApiConfig } from './config'
import type { AppContext } from './context'
import { RequestMetrics } from './observability'
import { Semaphore } from './semaphore'

const SECRET = 'observability-test-secret'
const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

function baseConfig(dir: string): ApiConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir: path.join(dir, 'data'),
    cacheDir: path.join(dir, 'cache'),
    mediaRoot: path.join(dir, 'media'),
    authSecret: SECRET,
    accel: false,
    hwaccel: null,
    secureCookies: false,
    scanIntervalMs: 60_000,
    fileMutationEnabled: false,
    hlsGenerationsEnabled: false,
    smartAlbumsEnabled: false,
    notificationsEnabled: false,
    trustProxy: [],
    publicOrigins: [],
    gpu: { resourceId: 'gpu:0' },
    search: { ftsEnabled: false },
    asr: {
      enabled: false,
      workerToken: 't',
      resultDir: path.join(dir, 'asr'),
      modelRevision: 'm',
      alignerRevision: 'a',
      pipelineVersion: 'p',
      retryMs: 60_000,
    },
    translation: {
      enabled: false,
      workerToken: 't',
      resultDir: path.join(dir, 'tr'),
      modelId: 'm',
      modelRevision: 'r',
      modelSha256: 's',
      promptVersion: 'p',
      pipelineVersion: 'v',
      targetLanguage: 'ko',
    },
    embedding: {
      enabled: false,
      workerToken: 't',
      modelId: 'm',
      modelRevision: 'r',
      modelSha256: 's',
      pipelineVersion: 'v',
      dimensions: 3,
    },
    scene: {
      enabled: false,
      workerToken: 't',
      modelId: 'm',
      modelRevision: 'r',
      modelSha256: 's',
      pipelineVersion: 'v',
      dimensions: 3,
      windowMs: 4000,
      overlapMs: 0,
      maxWindows: 120,
      queryUrl: 'http://127.0.0.1:9999',
    },
  }
}

async function createHarness() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-api-observability-'))
  dirs.push(dir)
  const config = baseConfig(dir)
  await mkdir(path.join(config.mediaRoot, 'Lib'), { recursive: true })
  await mkdir(config.cacheDir, { recursive: true })
  await mkdir(config.dataDir, { recursive: true })

  const db: Db = openDatabase(path.join(config.dataDir, 'mediavault.db'))
  createUser(db, { id: 'u1', username: 'owner', passwordHash: 'hash', createdAt: 1 })
  createLibrary(db, { id: 'lib1', name: 'Lib', rootPath: 'Lib', createdAt: 1 })
  const folderId = upsertFolder(db, {
    id: 'f1',
    libraryId: 'lib1',
    parentId: null,
    relativePath: '',
    name: 'Lib',
    depth: 0,
    scanId: 's1',
    createdAt: 1,
  })
  insertAsset(db, {
    id: 'a1',
    libraryId: 'lib1',
    folderId,
    relativePath: 'one.mp4',
    filename: 'one.mp4',
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 2048,
    mtimeMs: 1_000,
    width: null,
    height: null,
    durationMs: null,
    takenAt: 1,
    videoCodec: null,
    audioCodec: null,
    container: 'mp4',
    indexedAt: 1,
    scanId: 's1',
  })

  const ctx: AppContext = {
    config,
    db,
    metrics: new RequestMetrics(),
    thumbnails: new Semaphore(2),
    previews: new Semaphore(2),
  }
  const app = await buildApp(ctx)
  const token = createSession(db, 'u1', SECRET, { ttlMs: 3_600_000 }).token
  const headers = { cookie: `${SESSION_COOKIE}=${token}` }
  return { app, db, config, headers }
}

describe('request ids', () => {
  test('every response carries the server id and an error body echoes it', async () => {
    const h = await createHarness()

    const ok = await h.app.inject({ method: 'GET', url: '/api/system/capabilities', headers: h.headers })
    expect(ok.statusCode).toBe(200)
    const requestId = ok.headers['x-request-id']
    expect(typeof requestId).toBe('string')

    const missing = await h.app.inject({ method: 'GET', url: '/api/nope', headers: h.headers })
    expect(missing.statusCode).toBe(404)
    const errorRequestId = String(missing.headers['x-request-id'])
    expect(missing.json().requestId).toBe(errorRequestId)
    expect(errorRequestId.length).toBeGreaterThan(0)
  })

  test('a 5xx carries a short diagnostic id', async () => {
    const h = await createHarness()
    h.app.get('/api/boom', async () => {
      throw new Error('boom')
    })

    const response = await h.app.inject({ method: 'GET', url: '/api/boom', headers: h.headers })
    expect(response.statusCode).toBe(500)
    const body = response.json() as { error: string; requestId: string; diagnosticId: string }
    expect(body.error).toBe('internal')
    expect(body.requestId).toBe(String(response.headers['x-request-id']))
    expect(body.diagnosticId).toBe(body.requestId.slice(0, 8))
    expect(body.diagnosticId).toHaveLength(8)
  })
})

describe('capabilities and notifications', () => {
  test('the inbox is dark until the flag is on', async () => {
    const h = await createHarness()

    const capabilities = await h.app.inject({
      method: 'GET',
      url: '/api/system/capabilities',
      headers: h.headers,
    })
    expect(capabilities.json().notifications).toBe(false)

    const list = await h.app.inject({ method: 'GET', url: '/api/notifications', headers: h.headers })
    expect(list.statusCode).toBe(404)
  })

  test('an open incident lists once, marks read and dismisses', async () => {
    const h = await createHarness()
    h.config.notificationsEnabled = true

    const { notification } = upsertNotification(
      h.db,
      {
        kind: 'backup_failed',
        severity: 'warning',
        dedupeKey: 'backup:failed',
        title: '백업 실패',
        body: '다시 시도합니다.',
        metadata: { backupId: 'b1' },
      },
      Date.now(),
      60_000,
    )

    const list = await h.app.inject({
      method: 'GET',
      url: '/api/notifications?state=open',
      headers: h.headers,
    })
    expect(list.statusCode).toBe(200)
    const listed = list.json() as { notifications: Array<{ id: string; metadata: unknown }> }
    expect(listed.notifications).toHaveLength(1)
    expect(listed.notifications[0]!.id).toBe(notification.id)
    expect(listed.notifications[0]!.metadata).toEqual({ backupId: 'b1' })

    const unread = await h.app.inject({
      method: 'GET',
      url: '/api/notifications/unread',
      headers: h.headers,
    })
    expect(unread.json()).toEqual({ unread: 1, open: 1 })

    const read = await h.app.inject({
      method: 'POST',
      url: `/api/notifications/${notification.id}/read`,
      headers: h.headers,
    })
    expect(read.statusCode).toBe(200)
    expect(getNotification(h.db, notification.id)?.readAt).toBeNumber()

    const dismissed = await h.app.inject({
      method: 'POST',
      url: `/api/notifications/${notification.id}/dismiss`,
      headers: h.headers,
    })
    expect(dismissed.statusCode).toBe(200)
    expect(getNotification(h.db, notification.id)?.state).toBe('dismissed')
  })
})

describe('diagnostics', () => {
  test('the report redacts absolute roots and records the run', async () => {
    const h = await createHarness()
    h.db
      .query<null, [string, string]>('UPDATE libraries SET last_error = ? WHERE id = ?')
      .run(`${h.config.mediaRoot}/Lib/boom`, 'lib1')

    const response = await h.app.inject({
      method: 'GET',
      url: '/api/system/diagnostics?format=json',
      headers: h.headers,
    })
    expect(response.statusCode).toBe(200)
    const report = response.json() as DiagnosticsReportDTO
    expect(report.database.schemaVersion).toBe(25)
    expect(report.database.journalMode).toBe('wal')
    expect(report.libraries[0]!.lastError).toBe('<media>/Lib/boom')
    expect(report.flags.notifications).toBe(false)
    expect(report.caches.types.map((type) => type.type)).toContain('thumbs')

    const markdown = await h.app.inject({
      method: 'GET',
      url: '/api/system/diagnostics?format=md&download=1',
      headers: h.headers,
    })
    expect(markdown.statusCode).toBe(200)
    expect(markdown.headers['content-type']).toContain('text/markdown')
    expect(markdown.headers['content-disposition']).toContain('attachment')
    expect(markdown.body).toContain('# MediaVault diagnostics')
    expect(markdown.body).toContain('<media>/Lib/boom')
    expect(markdown.body).not.toContain(h.config.mediaRoot)

    // Only a download is an audit event; a page poll is not.
    expect(listDiagnosticsRuns(h.db)).toHaveLength(1)
  })
})

describe('cache cleanup', () => {
  async function seedCache(h: Awaited<ReturnType<typeof createHarness>>): Promise<void> {
    await mkdir(path.join(h.config.cacheDir, 'thumbs', 'a1', 'v1'), { recursive: true })
    await writeFile(path.join(h.config.cacheDir, 'thumbs', 'a1', 'v1', '320.webp'), 'current')
    await mkdir(path.join(h.config.cacheDir, 'thumbs', 'zz', 'v1'), { recursive: true })
    await writeFile(path.join(h.config.cacheDir, 'thumbs', 'zz', 'v1', '320.webp'), 'orphan!')
    await mkdir(path.join(h.config.cacheDir, 'tmp'), { recursive: true })
    const stale = path.join(h.config.cacheDir, 'tmp', 'leftover.tmp')
    await writeFile(stale, 'temp')
    const old = new Date(Date.now() - 48 * 60 * 60_000)
    await utimes(stale, old, old)
  }

  test('the inventory separates protected types from candidates', async () => {
    const h = await createHarness()
    await seedCache(h)

    const response = await h.app.inject({
      method: 'GET',
      url: '/api/system/cache',
      headers: h.headers,
    })
    expect(response.statusCode).toBe(200)
    const inventory = response.json() as CacheInventoryDTO
    const thumbs = inventory.types.find((type) => type.type === 'thumbs')
    expect(thumbs?.files).toBe(2)
    expect(inventory.types.find((type) => type.type === 'hls')?.protected).toBe(true)
  })

  test('a preview only lists orphans and stale temp, and clean refuses a moved set', async () => {
    const h = await createHarness()
    await seedCache(h)

    const preview = await h.app.inject({
      method: 'POST',
      url: '/api/system/cache/preview',
      headers: h.headers,
    })
    expect(preview.statusCode).toBe(200)
    const body = preview.json() as CacheCleanupPreviewDTO
    expect(body.files).toBe(2)
    expect(body.types).toEqual(['temp', 'thumbs'])
    expect(body.restoreCost).toContain('원본과 격리 파일은 삭제되지 않습니다.')

    const changed = await h.app.inject({
      method: 'POST',
      url: '/api/system/cache/clean',
      headers: h.headers,
      payload: { generation: 'deadbeefdeadbeef' },
    })
    expect(changed.statusCode).toBe(409)
    expect(changed.json().error).toBe('cache_preview_changed')

    const cleaned = await h.app.inject({
      method: 'POST',
      url: '/api/system/cache/clean',
      headers: h.headers,
      payload: { generation: body.generation },
    })
    expect(cleaned.statusCode).toBe(200)
    expect(cleaned.json()).toMatchObject({ deletedFiles: 2, failed: 0 })

    const current = await Bun.file(
      path.join(h.config.cacheDir, 'thumbs', 'a1', 'v1', '320.webp'),
    ).exists()
    const orphan = await Bun.file(
      path.join(h.config.cacheDir, 'thumbs', 'zz', 'v1', '320.webp'),
    ).exists()
    expect(current).toBe(true)
    expect(orphan).toBe(false)
    expect(listCacheCleanupRuns(h.db)).toHaveLength(1)
  })
})

describe('metrics', () => {
  test('the snapshot carries per-route latency and queue counts', async () => {
    const h = await createHarness()
    await h.app.inject({ method: 'GET', url: '/api/system/capabilities', headers: h.headers })

    const response = await h.app.inject({
      method: 'GET',
      url: '/api/system/metrics',
      headers: h.headers,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      requests: Array<{ method: string; route: string; count: number }>
      queues: Record<string, number>
    }
    const row = body.requests.find((entry) => entry.route === '/api/system/capabilities')
    expect(row?.method).toBe('GET')
    expect(row?.count).toBeGreaterThanOrEqual(1)
    expect(body.queues).toHaveProperty('queued')
  })
})
