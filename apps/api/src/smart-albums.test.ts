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
import type { SmartAlbumDTO, SmartAlbumPage } from '@mediavault/shared'
import { buildApp } from './app'
import { SESSION_COOKIE, createSession } from './auth'
import type { ApiConfig } from './config'
import type { AppContext } from './context'
import { Semaphore } from './semaphore'

const SECRET = 'smart-albums-test-secret'
const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

const VIDEOS = {
  version: 1,
  root: { type: 'cond', field: 'kind', operator: 'eq', value: 'video' },
} as const

const OVER_1K = {
  version: 1,
  root: { type: 'cond', field: 'sizeBytes', operator: 'gte', value: 2000 },
} as const

async function createHarness(options: { enabled?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-api-albums-'))
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
  const assets = [
    { id: 'vid001', name: 'vid001.mp4', kind: 'video', size: 1000, takenAt: 1000 },
    { id: 'vid002', name: 'vid002.mp4', kind: 'video', size: 2000, takenAt: 2000 },
    { id: 'vid003', name: 'vid003.mp4', kind: 'video', size: 3000, takenAt: 3000 },
    { id: 'img001', name: 'img001.jpg', kind: 'image', size: 500, takenAt: 4000 },
  ] as const
  for (const asset of assets) {
    insertAsset(db, {
      id: asset.id,
      libraryId: 'lib1',
      folderId,
      relativePath: asset.name,
      filename: asset.name,
      kind: asset.kind,
      mimeType: asset.kind === 'video' ? 'video/mp4' : 'image/jpeg',
      sizeBytes: asset.size,
      mtimeMs: 1_000,
      width: 100,
      height: 100,
      durationMs: asset.kind === 'video' ? 1_000 : null,
      takenAt: asset.takenAt,
      videoCodec: null,
      audioCodec: null,
      container: 'mp4',
      indexedAt: asset.takenAt,
      scanId: 's1',
    })
  }

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
    smartAlbumsEnabled: options.enabled ?? true,
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

async function createAlbum(harness: Harness, body: Record<string, unknown>): Promise<SmartAlbumDTO> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/smart-albums',
    headers: harness.headers,
    payload: body,
  })
  expect(response.statusCode).toBe(201)
  return response.json() as SmartAlbumDTO
}

describe('smart album API', () => {
  test('every route requires a session', async () => {
    const harness = await createHarness()
    for (const url of ['/api/smart-albums', '/api/smart-albums/abc']) {
      const response = await harness.app.inject({ method: 'GET', url })
      expect(response.statusCode).toBe(401)
    }
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/smart-albums',
      payload: { name: 'x', filter: VIDEOS },
    })
    expect(created.statusCode).toBe(401)
  })

  test('an album is created, listed, renamed and deleted', async () => {
    const harness = await createHarness()
    const album = await createAlbum(harness, {
      name: 'Videos',
      description: 'everything moving',
      filter: VIDEOS,
      sort: 'views',
    })
    expect(album.name).toBe('Videos')
    expect(album.description).toBe('everything moving')
    expect(album.sort).toBe('views')
    expect(album.pinned).toBe(false)
    expect(album.filter.valid).toBe(true)
    expect(album.filter.valid && album.filter.tree).toEqual(VIDEOS)

    const list = await harness.app.inject({ method: 'GET', url: '/api/smart-albums', headers: harness.headers })
    expect((list.json() as { albums: SmartAlbumDTO[] }).albums.map((entry) => entry.id)).toEqual([album.id])

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/smart-albums/${album.id}`,
      headers: harness.headers,
      payload: { name: 'Moving', pinned: true },
    })
    expect(patched.statusCode).toBe(200)
    const patchedBody = patched.json() as SmartAlbumDTO
    expect(patchedBody.name).toBe('Moving')
    expect(patchedBody.pinned).toBe(true)
    expect(patchedBody.sort).toBe('views')
    expect(patchedBody.filter.valid && patchedBody.filter.tree).toEqual(VIDEOS)

    const removed = await harness.app.inject({
      method: 'DELETE',
      url: `/api/smart-albums/${album.id}`,
      headers: harness.headers,
    })
    expect(removed.statusCode).toBe(204)
    const gone = await harness.app.inject({
      method: 'GET',
      url: `/api/smart-albums/${album.id}`,
      headers: harness.headers,
    })
    expect(gone.statusCode).toBe(404)
  })

  test('a second album with the same name is refused', async () => {
    const harness = await createHarness()
    await createAlbum(harness, { name: 'Videos', filter: VIDEOS })
    const duplicate = await harness.app.inject({
      method: 'POST',
      url: '/api/smart-albums',
      headers: harness.headers,
      payload: { name: 'videos', filter: VIDEOS },
    })
    expect(duplicate.statusCode).toBe(409)
    expect((duplicate.json() as { error: string }).error).toBe('name_taken')
  })

  test('an unusable filter is a 400, not a stored album', async () => {
    const harness = await createHarness()
    const bodies: Array<Record<string, unknown>> = [
      { name: 'a', filter: { version: 1, root: { type: 'cond', field: 'nope', operator: 'eq', value: 1 } } },
      { name: 'b', filter: { version: 1, root: { type: 'cond', field: 'kind', operator: 'contains', value: 'video' } } },
      { name: 'c', filter: { version: 1, root: { type: 'and', children: [] } } },
      {
        name: 'd',
        filter: {
          version: 1,
          root: {
            type: 'not',
            child: { type: 'not', child: { type: 'not', child: { type: 'not', child: { type: 'not', child: { type: 'not', child: { type: 'cond', field: 'kind', operator: 'eq', value: 'video' } } } } } },
          },
        },
      },
      {
        name: 'e',
        filter: {
          version: 1,
          root: {
            type: 'and',
            children: Array.from({ length: 51 }, () => ({ type: 'cond', field: 'kind', operator: 'eq', value: 'video' })),
          },
        },
      },
      { name: 'f' },
    ]
    for (const body of bodies) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/smart-albums',
        headers: harness.headers,
        payload: body,
      })
      expect(response.statusCode).toBe(400)
      expect((response.json() as { error: string }).error).toBe('invalid_request')
    }
    const list = await harness.app.inject({ method: 'GET', url: '/api/smart-albums', headers: harness.headers })
    expect((list.json() as { albums: SmartAlbumDTO[] }).albums).toEqual([])
  })

  test('an empty patch is refused and another user sees nothing', async () => {
    const harness = await createHarness()
    const album = await createAlbum(harness, { name: 'Videos', filter: VIDEOS })

    const empty = await harness.app.inject({
      method: 'PATCH',
      url: `/api/smart-albums/${album.id}`,
      headers: harness.headers,
      payload: {},
    })
    expect(empty.statusCode).toBe(400)

    for (const [method, url] of [
      ['GET', `/api/smart-albums/${album.id}`],
      ['GET', `/api/smart-albums/${album.id}/assets`],
      ['PATCH', `/api/smart-albums/${album.id}`],
      ['DELETE', `/api/smart-albums/${album.id}`],
    ] as const) {
      const response = await harness.app.inject({
        method,
        url,
        headers: harness.guest,
        payload: method === 'PATCH' ? { name: 'Stolen' } : undefined,
      })
      expect(response.statusCode).toBe(404)
    }
    const guestList = await harness.app.inject({
      method: 'GET',
      url: '/api/smart-albums',
      headers: harness.guest,
    })
    expect((guestList.json() as { albums: SmartAlbumDTO[] }).albums).toEqual([])
  })

  test('an album serves its own membership and pages through it', async () => {
    const harness = await createHarness()
    const album = await createAlbum(harness, { name: 'Videos', filter: VIDEOS })

    const first = await harness.app.inject({
      method: 'GET',
      url: `/api/smart-albums/${album.id}/assets?limit=2`,
      headers: harness.headers,
    })
    expect(first.statusCode).toBe(200)
    const firstPage = first.json() as SmartAlbumPage
    expect(firstPage.album.id).toBe(album.id)
    expect(firstPage.total).toBe(3)
    expect(firstPage.items.map((item) => item.id)).toEqual(['vid003', 'vid002'])
    expect(firstPage.nextCursor).not.toBeNull()

    const second = await harness.app.inject({
      method: 'GET',
      url: `/api/smart-albums/${album.id}/assets?limit=2&cursor=${firstPage.nextCursor}`,
      headers: harness.headers,
    })
    const secondPage = second.json() as SmartAlbumPage
    expect(secondPage.items.map((item) => item.id)).toEqual(['vid001'])
    expect(secondPage.nextCursor).toBeNull()

    const bad = await harness.app.inject({
      method: 'GET',
      url: `/api/smart-albums/${album.id}/assets?cursor=not-a-cursor`,
      headers: harness.headers,
    })
    expect(bad.statusCode).toBe(400)
    expect((bad.json() as { error: string }).error).toBe('invalid_cursor')
  })

  test('albumId narrows the gallery, the neighbor and the random pick', async () => {
    const harness = await createHarness()
    const videos = await createAlbum(harness, { name: 'Videos', filter: VIDEOS })
    const over1k = await createAlbum(harness, { name: 'Over 1k', filter: OVER_1K })

    const gallery = await harness.app.inject({
      method: 'GET',
      url: `/api/assets?albumId=${videos.id}`,
      headers: harness.headers,
    })
    expect((gallery.json() as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual([
      'vid003', 'vid002', 'vid001',
    ])

    const ids = await harness.app.inject({
      method: 'GET',
      url: `/api/assets/ids?albumId=${videos.id}`,
      headers: harness.headers,
    })
    expect((ids.json() as { ids: string[] }).ids.sort()).toEqual(['vid001', 'vid002', 'vid003'])

    const next = await harness.app.inject({
      method: 'GET',
      url: `/api/assets/vid002/neighbor?direction=next&albumId=${videos.id}`,
      headers: harness.headers,
    })
    expect((next.json() as { asset: { id: string } }).asset.id).toBe('vid001')

    const outside = await harness.app.inject({
      method: 'GET',
      url: `/api/assets/img001/neighbor?direction=next&albumId=${videos.id}`,
      headers: harness.headers,
    })
    expect(outside.statusCode).toBe(409)

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const random = await harness.app.inject({
        method: 'POST',
        url: '/api/assets/random',
        headers: harness.headers,
        payload: { albumId: over1k.id, seed: attempt },
      })
      const picked = (random.json() as { asset: { id: string } }).asset.id
      expect(['vid002', 'vid003', 'img001']).toContain(picked)
    }

    const missing = await harness.app.inject({
      method: 'GET',
      url: '/api/assets?albumId=doesnotexist',
      headers: harness.headers,
    })
    expect(missing.statusCode).toBe(404)
  })

  test('the album order applies unless the request names its own', async () => {
    const harness = await createHarness()
    const album = await createAlbum(harness, { name: 'Videos', filter: VIDEOS, sort: 'name' })

    const byName = await harness.app.inject({
      method: 'GET',
      url: `/api/assets?albumId=${album.id}`,
      headers: harness.headers,
    })
    expect((byName.json() as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual([
      'vid001', 'vid002', 'vid003',
    ])

    const byLatest = await harness.app.inject({
      method: 'GET',
      url: `/api/assets?albumId=${album.id}&sort=latest`,
      headers: harness.headers,
    })
    expect((byLatest.json() as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual([
      'vid003', 'vid002', 'vid001',
    ])

    const albumPage = await harness.app.inject({
      method: 'GET',
      url: `/api/smart-albums/${album.id}/assets`,
      headers: harness.headers,
    })
    expect((albumPage.json() as SmartAlbumPage).items.map((item) => item.id)).toEqual([
      'vid001', 'vid002', 'vid003',
    ])
  })

  test('a stored filter that no longer parses is refused with 409', async () => {
    const harness = await createHarness()
    const album = await createAlbum(harness, { name: 'Videos', filter: VIDEOS })
    harness.db
      .query<null, [string]>(`UPDATE smart_albums SET filter_json = '{"version":1,"root":{"type":"cond"}}' WHERE id = ?`)
      .run(album.id)

    for (const url of [`/api/smart-albums/${album.id}/assets`, `/api/assets?albumId=${album.id}`]) {
      const response = await harness.app.inject({ method: 'GET', url, headers: harness.headers })
      expect(response.statusCode).toBe(409)
      expect((response.json() as { error: string }).error).toBe('album_filter_invalid')
    }
    // The album itself stays readable so the client can offer to repair it.
    const read = await harness.app.inject({
      method: 'GET',
      url: `/api/smart-albums/${album.id}`,
      headers: harness.headers,
    })
    expect(read.statusCode).toBe(200)
    expect((read.json() as SmartAlbumDTO).filter.valid).toBe(false)
  })

  test('turning the flag off hides every album route', async () => {
    const harness = await createHarness({ enabled: false })
    const list = await harness.app.inject({ method: 'GET', url: '/api/smart-albums', headers: harness.headers })
    expect(list.statusCode).toBe(404)
    expect((list.json() as { error: string }).error).toBe('not_available')

    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/smart-albums',
      headers: harness.headers,
      payload: { name: 'Videos', filter: VIDEOS },
    })
    expect(create.statusCode).toBe(404)

    const gallery = await harness.app.inject({
      method: 'GET',
      url: '/api/assets?albumId=whatever',
      headers: harness.headers,
    })
    expect(gallery.statusCode).toBe(404)
    expect((gallery.json() as { error: string }).error).toBe('not_available')

    // The plain gallery is unaffected.
    const plain = await harness.app.inject({ method: 'GET', url: '/api/assets', headers: harness.headers })
    expect(plain.statusCode).toBe(200)
    expect((plain.json() as { total: number }).total).toBe(4)
  })
})
