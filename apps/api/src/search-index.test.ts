import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  completeAsrJob,
  configureSearchFts,
  createAsrJob,
  createLibrary,
  createUser,
  getActiveSearchIndexBuild,
  insertAsset,
  listSearchIndexBuilds,
  openDatabase,
  upsertFolder,
  type Db,
} from '@mediavault/database'
import type {
  DiagnosticsReportDTO,
  SearchIndexBuildDTO,
  SearchIndexGcPreviewDTO,
  SearchIndexStatusDTO,
} from '@mediavault/shared'
import { buildApp } from './app'
import { SESSION_COOKIE, createSession } from './auth'
import type { ApiConfig } from './config'
import type { AppContext } from './context'
import { RequestMetrics } from './observability'
import { RebuildInFlightError, rebuildSearchIndexNow } from './search-index'
import { Semaphore } from './semaphore'

const SECRET = 'search-index-test-secret'
const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

function baseConfig(dir: string, ftsEnabled: boolean): ApiConfig {
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
    search: { ftsEnabled },
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

async function createHarness(options: { fts?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-api-search-index-'))
  dirs.push(dir)
  const config = baseConfig(dir, options.fts ?? true)
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
    relativePath: '학교 축제.mp4',
    filename: '학교 축제.mp4',
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
  createAsrJob(
    db,
    {
      id: 'asr1',
      assetId: 'a1',
      fileVersion: 1,
      modelRevision: 'm',
      alignerRevision: 'a',
      pipelineVersion: 'p',
    },
    2_000,
  )
  completeAsrJob(
    db,
    {
      jobId: 'asr1',
      transcriptId: 'tr1',
      resultDir: 'a1/1/asr1',
      plainText: '오늘 학교에 갔다',
      language: 'ko',
      segments: [{ seq: 0, startMs: 1_000, endMs: 3_000, text: '오늘 학교에 갔다' }],
    },
    2_100,
  )

  const boot = configureSearchFts(db, config.search.ftsEnabled)

  const ctx: AppContext = {
    config,
    db,
    metrics: new RequestMetrics(),
    thumbnails: new Semaphore(2),
    previews: new Semaphore(2),
  }
  const app = await buildApp(ctx)
  const token = createSession(db, 'u1', SECRET, { ttlMs: 3_600_000 }).token
  return { app, db, ctx, config, boot, headers: { cookie: `${SESSION_COOKIE}=${token}` } }
}

/**
 * A context whose rebuild starts a second rebuild from inside its own
 * transaction, the only shape a concurrent rebuild can take on one thread.
 * `onNested` swallows the refusal so the outer rebuild can finish.
 */
function reentrantContext(ctx: AppContext, onNested?: (error: unknown) => void): AppContext {
  let fired = false
  const db = new Proxy(ctx.db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      if (property !== 'transaction') return value.bind(target)
      return (...args: unknown[]) => {
        if (!fired) {
          fired = true
          if (onNested) {
            try {
              rebuildSearchIndexNow(proxyCtx)
            } catch (error) {
              onNested(error)
            }
          } else {
            rebuildSearchIndexNow(proxyCtx)
          }
        }
        return (value as (...inner: unknown[]) => unknown).apply(target, args)
      }
    },
  }) as Db
  const proxyCtx: AppContext = { ...ctx, db }
  return proxyCtx
}

async function status(h: Awaited<ReturnType<typeof createHarness>>): Promise<SearchIndexStatusDTO> {
  const response = await h.app.inject({
    method: 'GET',
    url: '/api/system/search-index',
    headers: h.headers,
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as { status: SearchIndexStatusDTO }).status
}

describe('the status names the path a query takes', () => {
  test('fts when this process verified the active build', async () => {
    const h = await createHarness()
    expect(h.boot.mode).toBe('repaired')

    const body = await status(h)

    expect(body.fallback).toBe('fts')
    expect(body.processReady).toBe(true)
    expect(body.triggersArmed).toBe(true)
    expect(body.intact).toBe(true)
    expect(body.active?.id).toBe(h.boot.buildId!)
    expect(body.live).toEqual({
      assets: 1,
      segments: 1,
      assetWatermark: body.live?.assetWatermark ?? 0,
      segmentWatermark: body.live?.segmentWatermark ?? 0,
    })
    expect(body.live!.assetWatermark).toBeGreaterThan(0)
  })

  test('like-fallback when the triggers are disarmed but the index is intact', async () => {
    const h = await createHarness()
    configureSearchFts(h.db, false)

    const body = await status(h)

    expect(body.fallback).toBe('like-fallback')
    expect(body.processReady).toBe(false)
    expect(body.triggersArmed).toBe(false)
    expect(body.intact).toBe(true)
    expect(body.mode).toBe('off')
  })

  test('unavailable when a corpus is not an FTS5 table, and live is null', async () => {
    const h = await createHarness()
    h.db.exec('DROP TABLE segment_search')
    h.db.exec('CREATE TABLE segment_search (text TEXT)')

    const body = await status(h)

    expect(body.fallback).toBe('unavailable')
    expect(body.intact).toBe(false)
    expect(body.live).toBeNull()
    expect(body.rowsSinceBuild).toBeNull()
    expect(body.active).not.toBeNull()
  })

  test('rowsSinceBuild grows after a write the triggers did not see', async () => {
    const h = await createHarness()
    configureSearchFts(h.db, false)
    expect((await status(h)).rowsSinceBuild).toEqual({ assets: 0, segments: 0 })

    insertAsset(h.db, {
      id: 'a2',
      libraryId: 'lib1',
      folderId: 'f1',
      relativePath: '새 영상.mp4',
      filename: '새 영상.mp4',
      kind: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 1,
      mtimeMs: 1,
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

    const body = await status(h)

    expect(body.rowsSinceBuild?.assets).toBe(1)
    expect(body.triggersArmed).toBe(false)
  })
})

describe('rebuilding from the panel', () => {
  test('returns 201 with the new build and makes it active', async () => {
    const h = await createHarness()
    const first = getActiveSearchIndexBuild(h.db, 'fts')!

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/system/search-index/rebuild',
      headers: h.headers,
    })

    expect(response.statusCode).toBe(201)
    const build = response.json() as SearchIndexBuildDTO
    expect(build.state).toBe('ready')
    expect(build.source).toBe('operator')
    expect(build.assets).toBe(1)
    expect(build.id).not.toBe(first.id)

    const body = await status(h)
    expect(body.active?.id).toBe(build.id)
    expect(body.recent.find((row) => row.id === first.id)?.state).toBe('superseded')
  })

  test('a rebuild that fails returns a masked 500 and keeps the old build', async () => {
    const h = await createHarness()
    const first = getActiveSearchIndexBuild(h.db, 'fts')!

    h.db.exec('PRAGMA query_only = 1')
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/system/search-index/rebuild',
      headers: h.headers,
    })
    h.db.exec('PRAGMA query_only = 0')

    expect(response.statusCode).toBe(500)
    const body = response.json() as { error: string; message: string; diagnosticId?: string }
    expect(body.error).toBe('internal')
    expect(body.message).toBe('Something went wrong.')
    expect(typeof body.diagnosticId).toBe('string')

    const after = await status(h)
    expect(after.active?.id).toBe(first.id)
    expect(after.active?.state).toBe('ready')
  })

  test('a rebuild started while one is in flight is refused with 409', async () => {
    const h = await createHarness()
    const first = getActiveSearchIndexBuild(h.db, 'fts')!
    // The rebuild is synchronous, so the only way a second one can start is
    // re-entry from inside the first. This is the guard the route maps to 409.
    const proxyCtx = reentrantContext(h.ctx)

    const app = await buildApp(proxyCtx)
    const response = await app.inject({
      method: 'POST',
      url: '/api/system/search-index/rebuild',
      headers: h.headers,
    })
    await app.close()

    expect(response.statusCode).toBe(409)
    expect((response.json() as { error: string }).error).toBe('rebuild_in_flight')
    expect(getActiveSearchIndexBuild(h.db, 'fts')?.id).toBe(first.id)
  })

  test('the guard throws before it touches SQLite', async () => {
    const h = await createHarness()
    const before = listSearchIndexBuilds(h.db, 'fts', 10).length

    // Re-entry is the only way to observe the flag, and the guard runs before
    // the second call reaches the database.
    let nested: unknown = null
    const innerCtx = reentrantContext(h.ctx, (error) => {
      nested = error
    })

    rebuildSearchIndexNow(innerCtx)

    expect(nested).toBeInstanceOf(RebuildInFlightError)
    expect(listSearchIndexBuilds(h.db, 'fts', 10)).toHaveLength(before + 1)
  })
})

describe('collecting old build rows', () => {
  test('a preview lists only what the delete would remove', async () => {
    const h = await createHarness()
    for (let run = 0; run < 2; run += 1) {
      await h.app.inject({
        method: 'POST',
        url: '/api/system/search-index/rebuild',
        headers: h.headers,
      })
    }

    const preview = await h.app.inject({
      method: 'GET',
      url: '/api/system/search-index/gc/preview',
      headers: h.headers,
    })
    expect(preview.statusCode).toBe(200)
    // Nothing is past the 30 day retention window yet.
    expect(preview.json() as SearchIndexGcPreviewDTO).toEqual({ builds: [], total: 0 })

    const cleaned = await h.app.inject({
      method: 'POST',
      url: '/api/system/search-index/gc',
      headers: h.headers,
    })
    expect(cleaned.statusCode).toBe(200)
    expect((cleaned.json() as { deleted: number }).deleted).toBe(0)
    expect(getActiveSearchIndexBuild(h.db, 'fts')).not.toBeNull()
  })
})

describe('diagnostics carries the index', () => {
  test('the report embeds the status and the markdown renders the section', async () => {
    const h = await createHarness()
    const active = getActiveSearchIndexBuild(h.db, 'fts')!

    const json = await h.app.inject({
      method: 'GET',
      url: '/api/system/diagnostics?format=json',
      headers: h.headers,
    })
    expect(json.statusCode).toBe(200)
    const report = json.json() as DiagnosticsReportDTO
    expect(report.searchIndex.fallback).toBe('fts')
    expect(report.searchIndex.active?.id).toBe(active.id)

    const markdown = await h.app.inject({
      method: 'GET',
      url: '/api/system/diagnostics?format=md',
      headers: h.headers,
    })
    expect(markdown.statusCode).toBe(200)
    const body = markdown.body
    expect(body).toContain('## Search index')
    expect(body).toContain(active.id.slice(0, 8))
    expect(body).toContain('| fallback | fts |')
    expect(body).toContain('| triggersArmed | true |')
  })
})
