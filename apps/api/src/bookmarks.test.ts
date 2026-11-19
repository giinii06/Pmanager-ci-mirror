import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
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
import type { VideoBookmarkDTO } from '@mediavault/shared'
import { buildApp } from './app'
import { SESSION_COOKIE, createSession } from './auth'
import type { ApiConfig } from './config'
import type { AppContext } from './context'
import { Semaphore } from './semaphore'

const SECRET = 'bookmarks-test-secret'
const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function createHarness() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-api-bookmarks-'))
  dirs.push(dir)
  const mediaRoot = path.join(dir, 'media')
  const cacheDir = path.join(dir, 'cache')
  const dataDir = path.join(dir, 'data')
  await mkdir(path.join(mediaRoot, 'Lib'), { recursive: true })
  await mkdir(cacheDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })

  const db: Db = openDatabase(path.join(dataDir, 'mediavault.db'))
  createUser(db, { id: 'u1', username: 'owner', passwordHash: 'hash', createdAt: 1 })
  createUser(db, { id: 'u2', username: 'guest', passwordHash: 'hash', createdAt: 1 })
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
    id: 'vid001',
    libraryId: 'lib1',
    folderId,
    relativePath: 'vid001.mp4',
    filename: 'vid001.mp4',
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 1_000,
    mtimeMs: 1_000,
    width: 100,
    height: 100,
    durationMs: 60_000,
    takenAt: 1_000,
    videoCodec: null,
    audioCodec: null,
    container: 'mp4',
    indexedAt: 1_000,
    scanId: 's1',
  })

  const config: ApiConfig = {
    port: 0,
    host: '127.0.0.1',
    dataDir,
    cacheDir,
    mediaRoot,
    authSecret: SECRET,
    accel: false,
    hwaccel: null,
    secureCookies: false,
    scanIntervalMs: 60_000,
    fileMutationEnabled: false,
    hlsGenerationsEnabled: false,
    smartAlbumsEnabled: true,
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

  const ctx: AppContext = { config, db, thumbnails: new Semaphore(2), previews: new Semaphore(2) }
  const app = await buildApp(ctx)
  const headers = { cookie: `${SESSION_COOKIE}=${createSession(db, 'u1', SECRET, { ttlMs: 3_600_000 }).token}` }
  const guest = { cookie: `${SESSION_COOKIE}=${createSession(db, 'u2', SECRET, { ttlMs: 3_600_000 }).token}` }
  return { app, db, headers, guest }
}

type Harness = Awaited<ReturnType<typeof createHarness>>

async function createBookmark(harness: Harness, payload: Record<string, unknown>): Promise<VideoBookmarkDTO> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/assets/vid001/bookmarks',
    headers: harness.headers,
    payload,
  })
  expect(response.statusCode).toBe(201)
  return response.json() as VideoBookmarkDTO
}

async function listBookmarks(harness: Harness): Promise<VideoBookmarkDTO[]> {
  const response = await harness.app.inject({
    method: 'GET',
    url: '/api/assets/vid001/bookmarks',
    headers: harness.headers,
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as { bookmarks: VideoBookmarkDTO[] }).bookmarks
}

describe('bookmark API', () => {
  test('every route requires a session', async () => {
    const harness = await createHarness()
    for (const [method, url] of [
      ['GET', '/api/assets/vid001/bookmarks'],
      ['POST', '/api/assets/vid001/bookmarks'],
      ['PATCH', '/api/bookmarks/abc'],
      ['DELETE', '/api/bookmarks/abc'],
    ] as const) {
      const response = await harness.app.inject({
        method,
        url,
        payload: method === 'POST' ? { positionMs: 0 } : method === 'PATCH' ? { title: 'x' } : undefined,
      })
      expect(response.statusCode).toBe(401)
    }
  })

  test('a mark is created, listed, edited and deleted', async () => {
    const harness = await createHarness()
    const created = await createBookmark(harness, { positionMs: 15_000, title: 'Opening', note: 'the good part' })
    expect(created).toMatchObject({
      assetId: 'vid001',
      positionMs: 15_000,
      title: 'Opening',
      note: 'the good part',
      fileVersion: 1,
      stale: false,
    })
    expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false)

    await createBookmark(harness, { positionMs: 3_000 })
    expect((await listBookmarks(harness)).map((bookmark) => bookmark.positionMs)).toEqual([3_000, 15_000])

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/bookmarks/${created.id}`,
      headers: harness.headers,
      payload: { positionMs: 40_000, note: null },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json() as VideoBookmarkDTO).toMatchObject({ positionMs: 40_000, title: 'Opening', note: null })

    const removed = await harness.app.inject({
      method: 'DELETE',
      url: `/api/bookmarks/${created.id}`,
      headers: harness.headers,
    })
    expect(removed.statusCode).toBe(204)
    expect((await listBookmarks(harness)).map((bookmark) => bookmark.positionMs)).toEqual([3_000])
  })

  test('a mark reports stale after the file version moves', async () => {
    const harness = await createHarness()
    const created = await createBookmark(harness, { positionMs: 1_000 })
    harness.db.query<null, [string]>('UPDATE assets SET file_version = file_version + 1 WHERE id = ?').run('vid001')

    const listed = (await listBookmarks(harness))[0]!
    expect(listed.stale).toBe(true)
    expect(listed.fileVersion).toBe(created.fileVersion)

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/bookmarks/${created.id}`,
      headers: harness.headers,
      payload: { title: 'Renamed' },
    })
    expect((patched.json() as VideoBookmarkDTO).stale).toBe(true)
  })

  test('a position past the end of the video is a 422 carrying the duration', async () => {
    const harness = await createHarness()
    for (const positionMs of [61_500, 120_000]) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/assets/vid001/bookmarks',
        headers: harness.headers,
        payload: { positionMs },
      })
      expect(response.statusCode).toBe(422)
      expect(response.json() as { error: string; details: { durationMs: number } }).toMatchObject({
        error: 'out_of_range',
        details: { durationMs: 60_000 },
      })
    }

    const created = await createBookmark(harness, { positionMs: 1_000 })
    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/bookmarks/${created.id}`,
      headers: harness.headers,
      payload: { positionMs: 90_000 },
    })
    expect(patched.statusCode).toBe(422)
    expect((await listBookmarks(harness))[0]?.positionMs).toBe(1_000)
  })

  test('a malformed body is a 400', async () => {
    const harness = await createHarness()
    const created = await createBookmark(harness, { positionMs: 1_000 })
    for (const [url, method, payload] of [
      ['/api/assets/vid001/bookmarks', 'POST', {}],
      ['/api/assets/vid001/bookmarks', 'POST', { positionMs: -1 }],
      ['/api/assets/vid001/bookmarks', 'POST', { positionMs: 1.5 }],
      ['/api/assets/vid001/bookmarks', 'POST', { positionMs: 'soon' }],
      ['/api/assets/vid001/bookmarks', 'POST', { positionMs: 0, title: 'x'.repeat(121) }],
      ['/api/assets/vid001/bookmarks', 'POST', { positionMs: 0, note: 'x'.repeat(2001) }],
      [`/api/bookmarks/${created.id}`, 'PATCH', {}],
      [`/api/bookmarks/${created.id}`, 'PATCH', { positionMs: -5 }],
      [`/api/bookmarks/${created.id}`, 'PATCH', { title: 'x'.repeat(121) }],
    ] as const) {
      const response = await harness.app.inject({ method, url, headers: harness.headers, payload })
      expect(response.statusCode).toBe(400)
      expect((response.json() as { error: string }).error).toBe('invalid_request')
    }
    expect(await listBookmarks(harness)).toHaveLength(1)
  })

  test('another user cannot read, edit or delete the mark, and a missing asset is a 404', async () => {
    const harness = await createHarness()
    const created = await createBookmark(harness, { positionMs: 1_000, title: 'Mine' })

    const guestList = await harness.app.inject({
      method: 'GET',
      url: '/api/assets/vid001/bookmarks',
      headers: harness.guest,
    })
    expect((guestList.json() as { bookmarks: VideoBookmarkDTO[] }).bookmarks).toEqual([])

    for (const [method, url, payload] of [
      ['PATCH', `/api/bookmarks/${created.id}`, { title: 'Stolen' }],
      ['DELETE', `/api/bookmarks/${created.id}`, undefined],
    ] as const) {
      const response = await harness.app.inject({ method, url, headers: harness.guest, payload })
      expect(response.statusCode).toBe(404)
    }
    expect((await listBookmarks(harness))[0]).toMatchObject({ title: 'Mine', positionMs: 1_000 })

    const missing = await harness.app.inject({
      method: 'GET',
      url: '/api/assets/doesnotexist/bookmarks',
      headers: harness.headers,
    })
    expect(missing.statusCode).toBe(404)
    const missingCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/assets/doesnotexist/bookmarks',
      headers: harness.headers,
      payload: { positionMs: 0 },
    })
    expect(missingCreate.statusCode).toBe(404)
    expect((missingCreate.json() as { error: string }).error).toBe('asset_not_found')
  })
})
