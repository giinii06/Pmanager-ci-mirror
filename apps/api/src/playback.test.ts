import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createLibrary,
  createUser,
  insertAsset,
  openDatabase,
  upsertFolder,
  type Db,
} from '@mediavault/database'
import { buildApp } from './app'
import { SESSION_COOKIE, createSession } from './auth'
import type { ApiConfig } from './config'
import type { AppContext } from './context'
import { Semaphore } from './semaphore'

const SECRET = 'test-secret-for-session-signing'
const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function createHarness() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-playback-'))
  dirs.push(dir)
  const db: Db = openDatabase(':memory:')
  createUser(db, { id: 'u1', username: 'owner', passwordHash: 'x', createdAt: 1 })
  createUser(db, { id: 'u2', username: 'other', passwordHash: 'x', createdAt: 1 })
  createLibrary(db, { id: 'lib1', name: 'Videos', rootPath: dir, createdAt: 1 })
  upsertFolder(db, {
    id: 'folder0001',
    libraryId: 'lib1',
    parentId: null,
    relativePath: '',
    name: 'Videos',
    depth: 0,
    scanId: 's1',
    createdAt: 1,
  })
  insertAsset(db, {
    id: 'asset0001',
    libraryId: 'lib1',
    folderId: 'folder0001',
    relativePath: 'clip.mp4',
    filename: 'clip.mp4',
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 1000,
    mtimeMs: 1000,
    width: 160,
    height: 120,
    durationMs: 120_000,
    takenAt: 1000,
    videoCodec: 'h264',
    audioCodec: null,
    container: 'mp4',
    indexedAt: 1,
    scanId: 's1',
  })

  const config: ApiConfig = {
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    cacheDir: dir,
    mediaRoot: dir,
    authSecret: SECRET,
    accel: false,
    hwaccel: null,
    secureCookies: false,
    scanIntervalMs: 60_000,
    fileMutationEnabled: false,
    hlsGenerationsEnabled: false,
    trustProxy: [],
    publicOrigins: [],
    gpu: { resourceId: 'gpu:0' },
    asr: {
      enabled: false,
      workerToken: '',
      resultDir: dir,
      modelRevision: 'asr',
      alignerRevision: 'align',
      pipelineVersion: '1',
      retryMs: 60_000,
    },
    translation: {
      enabled: false,
      workerToken: '',
      resultDir: dir,
      modelId: 'tr',
      modelRevision: '1',
      modelSha256: 'x',
      promptVersion: '1',
      pipelineVersion: '1',
      targetLanguage: 'ko',
    },
    embedding: {
      enabled: false,
      workerToken: '',
      modelId: 'emb',
      modelRevision: '1',
      modelSha256: 'x',
      pipelineVersion: '1',
      dimensions: 4,
    },
    scene: {
      enabled: false,
      workerToken: '',
      modelId: 'scene',
      modelRevision: '1',
      modelSha256: 'x',
      pipelineVersion: '1',
      dimensions: 4,
      windowMs: 10_000,
      overlapMs: 2_000,
      maxWindows: 120,
      queryUrl: 'http://127.0.0.1:1',
    },
  }

  const ctx: AppContext = { db, config, thumbnails: new Semaphore(1), previews: new Semaphore(1) }
  const app = await buildApp(ctx)
  const headers = { cookie: `${SESSION_COOKIE}=${createSession(db, 'u1', SECRET).token}` }
  const otherHeaders = { cookie: `${SESSION_COOKIE}=${createSession(db, 'u2', SECRET).token}` }
  return { app, db, headers, otherHeaders }
}

async function startSession(
  app: Awaited<ReturnType<typeof createHarness>>['app'],
  headers: Record<string, string>,
  key = 'clientkey01',
  fileVersion = 1,
) {
  return app.inject({
    method: 'POST',
    url: '/api/play-sessions',
    headers,
    payload: { assetId: 'asset0001', fileVersion, clientSessionKey: key },
  })
}

function event(
  sessionId: string,
  seq: number,
  type: 'view' | 'watch_time' | 'progress',
  extra: Record<string, number> = {},
) {
  return {
    eventId: `event${String(seq).padStart(8, '0')}`,
    seq,
    type,
    ...extra,
  }
}

describe('play session API', () => {
  test('creates a session once per client key and reports its file version', async () => {
    const h = await createHarness()
    const first = await startSession(h.app, h.headers)
    expect(first.statusCode).toBe(201)
    const body = first.json() as {
      sessionId: string
      assetId: string
      fileVersion: number
      issuedAt: string
    }
    expect(body).toMatchObject({ assetId: 'asset0001', fileVersion: 1 })
    expect(Number.isNaN(Date.parse(body.issuedAt))).toBe(false)

    const retry = await startSession(h.app, h.headers)
    expect(retry.statusCode).toBe(200)
    expect((retry.json() as { sessionId: string }).sessionId).toBe(body.sessionId)
  })

  test('rejects a stale file version and an unknown asset', async () => {
    const h = await createHarness()
    const stale = await startSession(h.app, h.headers, 'clientkey02', 2)
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ error: 'file_version_changed', fileVersion: 1 })

    const missing = await h.app.inject({
      method: 'POST',
      url: '/api/play-sessions',
      headers: h.headers,
      payload: { assetId: 'missing1', fileVersion: 1, clientSessionKey: 'clientkey03' },
    })
    expect(missing.statusCode).toBe(404)
  })

  test('aggregates view, watch time and progress exactly once across retries', async () => {
    const h = await createHarness()
    const sessionId = (await startSession(h.app, h.headers)).json().sessionId as string

    const view = await h.app.inject({
      method: 'POST',
      url: `/api/play-sessions/${sessionId}/events`,
      headers: h.headers,
      payload: event(sessionId, 1, 'view'),
    })
    expect(view.statusCode).toBe(200)
    expect(view.json()).toMatchObject({ applied: true, duplicate: false, viewCount: 1, lastSeq: 1 })

    const watch = event(sessionId, 2, 'watch_time', { deltaMs: 4_000 })
    const watchRes = await h.app.inject({
      method: 'POST',
      url: `/api/play-sessions/${sessionId}/events`,
      headers: h.headers,
      payload: watch,
    })
    expect(watchRes.json()).toMatchObject({ applied: true, watchTimeMs: 4_000, lastSeq: 2 })

    const watchRetry = await h.app.inject({
      method: 'POST',
      url: `/api/play-sessions/${sessionId}/events`,
      headers: h.headers,
      payload: watch,
    })
    expect(watchRetry.statusCode).toBe(200)
    expect(watchRetry.json()).toMatchObject({ applied: false, duplicate: true, watchTimeMs: 4_000 })

    const progress = await h.app.inject({
      method: 'POST',
      url: `/api/play-sessions/${sessionId}/events`,
      headers: h.headers,
      payload: event(sessionId, 3, 'progress', { positionMs: 50_000, durationMs: 120_000 }),
    })
    expect(progress.statusCode).toBe(200)
    expect(progress.json()).toMatchObject({
      applied: true,
      viewCount: 1,
      watchTimeMs: 4_000,
      progress: {
        assetId: 'asset0001',
        positionMs: 50_000,
        durationMs: 120_000,
        fileVersion: 1,
        progressVersion: 1,
      },
    })

    // A second view event in the same session is accepted but adds no count.
    const secondView = await h.app.inject({
      method: 'POST',
      url: `/api/play-sessions/${sessionId}/events`,
      headers: h.headers,
      payload: event(sessionId, 4, 'view'),
    })
    expect(secondView.json()).toMatchObject({ applied: true, viewCount: 1 })

    const stored = await h.app.inject({
      method: 'GET',
      url: '/api/playback/asset0001',
      headers: h.headers,
    })
    expect(stored.json()).toMatchObject({
      progress: { positionMs: 50_000, fileVersion: 1, progressVersion: 1 },
    })
  })

  test('refuses a gap and a reused sequence', async () => {
    const h = await createHarness()
    const sessionId = (await startSession(h.app, h.headers)).json().sessionId as string
    const url = `/api/play-sessions/${sessionId}/events`

    const gap = await h.app.inject({
      method: 'POST',
      url,
      headers: h.headers,
      payload: event(sessionId, 2, 'watch_time', { deltaMs: 1_000 }),
    })
    expect(gap.statusCode).toBe(409)
    expect(gap.json()).toMatchObject({ error: 'sequence_gap', expectedSeq: 1 })

    await h.app.inject({
      method: 'POST',
      url,
      headers: h.headers,
      payload: event(sessionId, 1, 'view'),
    })
    const reused = await h.app.inject({
      method: 'POST',
      url,
      headers: h.headers,
      payload: {
        eventId: 'differentev01',
        seq: 1,
        type: 'view',
      },
    })
    expect(reused.statusCode).toBe(409)
    expect(reused.json()).toMatchObject({ error: 'sequence_conflict' })
  })

  test('rejects a different payload under the same event id', async () => {
    const h = await createHarness()
    const sessionId = (await startSession(h.app, h.headers)).json().sessionId as string
    const url = `/api/play-sessions/${sessionId}/events`
    const payload = event(sessionId, 1, 'watch_time', { deltaMs: 2_000 })
    await h.app.inject({ method: 'POST', url, headers: h.headers, payload })
    const changed = await h.app.inject({
      method: 'POST',
      url,
      headers: h.headers,
      payload: { ...payload, deltaMs: 3_000 },
    })
    expect(changed.statusCode).toBe(409)
    expect(changed.json()).toMatchObject({ error: 'event_id_conflict' })
  })

  test('does not let another user post to a session', async () => {
    const h = await createHarness()
    const sessionId = (await startSession(h.app, h.headers)).json().sessionId as string
    const foreign = await h.app.inject({
      method: 'POST',
      url: `/api/play-sessions/${sessionId}/events`,
      headers: h.otherHeaders,
      payload: event(sessionId, 1, 'view'),
    })
    expect(foreign.statusCode).toBe(404)
    const read = await h.app.inject({
      method: 'GET',
      url: '/api/playback/asset0001',
      headers: h.otherHeaders,
    })
    expect(read.json()).toEqual({ progress: null })
  })

  test('validates type-specific event payloads', async () => {
    const h = await createHarness()
    const sessionId = (await startSession(h.app, h.headers)).json().sessionId as string
    const url = `/api/play-sessions/${sessionId}/events`
    const missingDelta = await h.app.inject({
      method: 'POST',
      url,
      headers: h.headers,
      payload: { eventId: 'event0000001', seq: 1, type: 'watch_time' },
    })
    expect(missingDelta.statusCode).toBe(400)
    const missingPosition = await h.app.inject({
      method: 'POST',
      url,
      headers: h.headers,
      payload: { eventId: 'event0000002', seq: 1, type: 'progress', durationMs: 1000 },
    })
    expect(missingPosition.statusCode).toBe(400)
  })

  test('answers a stale session after a file version change', async () => {
    const h = await createHarness()
    const sessionId = (await startSession(h.app, h.headers)).json().sessionId as string
    h.db.query('UPDATE assets SET file_version = 2 WHERE id = ?').run('asset0001')
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/play-sessions/${sessionId}/events`,
      headers: h.headers,
      payload: event(sessionId, 1, 'view'),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'file_version_changed', fileVersion: 2 })
  })

  test('keeps the legacy playback endpoints working and fenced', async () => {
    const h = await createHarness()
    const legacyView = await h.app.inject({
      method: 'POST',
      url: '/api/assets/asset0001/view',
      headers: h.headers,
    })
    expect(legacyView.statusCode).toBe(200)
    expect(legacyView.json()).toMatchObject({ viewCount: 1 })

    const legacyWatch = await h.app.inject({
      method: 'POST',
      url: '/api/assets/asset0001/watch-time',
      headers: h.headers,
      payload: { deltaMs: 2_000 },
    })
    expect(legacyWatch.json()).toMatchObject({ watchTimeMs: 2_000 })

    const legacyProgress = await h.app.inject({
      method: 'PUT',
      url: '/api/playback/asset0001',
      headers: h.headers,
      payload: { positionMs: 10_000, durationMs: 120_000 },
    })
    expect(legacyProgress.statusCode).toBe(204)

    const sessionId = (await startSession(h.app, h.headers)).json().sessionId as string
    await h.app.inject({
      method: 'POST',
      url: `/api/play-sessions/${sessionId}/events`,
      headers: h.headers,
      payload: event(sessionId, 1, 'progress', { positionMs: 60_000, durationMs: 120_000 }),
    })
    const fenced = await h.app.inject({
      method: 'PUT',
      url: '/api/playback/asset0001',
      headers: h.headers,
      payload: { positionMs: 5_000, durationMs: 120_000 },
    })
    expect(fenced.statusCode).toBe(204)
    const read = await h.app.inject({
      method: 'GET',
      url: '/api/playback/asset0001',
      headers: h.headers,
    })
    expect((read.json() as { progress: { positionMs: number } }).progress.positionMs).toBe(60_000)
  })

  test('dedupes a vote retry but counts a second click', async () => {
    const h = await createHarness()
    const first = await h.app.inject({
      method: 'POST',
      url: '/api/assets/asset0001/vote',
      headers: h.headers,
      payload: { clientRequestId: 'request0001' },
    })
    expect(first.json()).toMatchObject({ voteCount: 1 })
    const retry = await h.app.inject({
      method: 'POST',
      url: '/api/assets/asset0001/vote',
      headers: h.headers,
      payload: { clientRequestId: 'request0001' },
    })
    expect(retry.json()).toMatchObject({ voteCount: 1 })
    const second = await h.app.inject({
      method: 'POST',
      url: '/api/assets/asset0001/vote',
      headers: h.headers,
      payload: { clientRequestId: 'request0002' },
    })
    expect(second.json()).toMatchObject({ voteCount: 2 })
  })
})
