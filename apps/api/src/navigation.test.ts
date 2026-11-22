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
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-navigation-'))
  dirs.push(dir)
  const db: Db = openDatabase(':memory:')
  createUser(db, { id: 'u1', username: 'owner', passwordHash: 'x', createdAt: 1 })
  createLibrary(db, { id: 'lib1', name: 'Media', rootPath: dir, createdAt: 1 })
  for (const [id, relativePath, name] of [
    ['folder0001', '', 'Media'],
    ['folder0009', 'empty', 'empty'],
  ] as const) {
    upsertFolder(db, {
      id,
      libraryId: 'lib1',
      parentId: null,
      relativePath,
      name,
      depth: 0,
      scanId: 's1',
      createdAt: 1,
    })
  }

  for (let index = 1; index <= 5; index += 1) {
    insertAsset(db, {
      id: `v00000${index}`,
      libraryId: 'lib1',
      folderId: 'folder0001',
      relativePath: `clip-${index}.mp4`,
      filename: `clip-${index}.mp4`,
      kind: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 1000,
      mtimeMs: 1000,
      width: 160,
      height: 120,
      durationMs: 120_000,
      takenAt: index * 100,
      videoCodec: 'h264',
      audioCodec: null,
      container: 'mp4',
      indexedAt: 1,
      scanId: 's1',
    })
  }
  insertAsset(db, {
    id: 'i000001',
    libraryId: 'lib1',
    folderId: 'folder0001',
    relativePath: 'photo.jpg',
    filename: 'photo.jpg',
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 500,
    mtimeMs: 500,
    width: 100,
    height: 100,
    durationMs: null,
    takenAt: 900,
    videoCodec: null,
    audioCodec: null,
    container: null,
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
    smartAlbumsEnabled: false,
    trustProxy: [],
    publicOrigins: [],
    gpu: { resourceId: 'gpu:0' },
    search: { ftsEnabled: false },
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
  return { app, headers, db }
}

describe('navigation API', () => {
  test('global search lists only matching filenames, supports paging and escapes wildcards', async () => {
    const h = await createHarness()
    const get = (q: string) => h.app.inject({
      method: 'GET',
      url: '/api/assets?q=' + encodeURIComponent(q),
      headers: h.headers,
    })

    const movie = await get('clip-1')
    expect(movie.statusCode).toBe(200)
    expect((movie.json() as { total: number; items: Array<{ filename: string }> }).items.map((item) => item.filename))
      .toEqual(['clip-1.mp4'])

    const photo = await get('jpg')
    expect((photo.json() as { total: number; items: Array<{ kind: string }> }).items.map((item) => item.kind))
      .toEqual(['image'])

    // One-character Korean/ASCII input is valid, and special LIKE characters are literal.
    expect((await get('1')).json().total).toBe(1)
    expect((await get('%')).json().total).toBe(0)
    expect((await get('_')).json().total).toBe(0)
    expect((await get('owner')).json().total).toBe(0)

    const first = await h.app.inject({
      method: 'GET',
      url: '/api/assets?q=clip&limit=2',
      headers: h.headers,
    })
    const firstPage = first.json() as { total: number; items: Array<{ id: string }>; nextCursor: string }
    expect(firstPage.total).toBe(5)
    expect(firstPage.items).toHaveLength(2)
    expect(firstPage.nextCursor).toBeTruthy()

    const second = await h.app.inject({
      method: 'GET',
      url: '/api/assets?q=clip&limit=2&cursor=' + encodeURIComponent(firstPage.nextCursor),
      headers: h.headers,
    })
    const secondPage = second.json() as { items: Array<{ id: string }> }
    expect(secondPage.items).toHaveLength(2)
    expect(secondPage.items.every((item) => !firstPage.items.some((firstItem) => firstItem.id === item.id)))
      .toBe(true)

    // A Korean filename is found even by a single Korean syllable.
    h.db.query('UPDATE assets SET filename = ? WHERE id = ?').run('부산여행.mp4', 'v000005')
    expect((await get('산')).json().total).toBe(1)

    // LIKE metacharacters in actual names are treated literally, not as patterns.
    h.db.query('UPDATE assets SET filename = ? WHERE id = ?').run('sea_100%.mp4', 'v000004')
    expect((await get('_')).json().total).toBe(1)
    expect((await get('%')).json().total).toBe(1)
    expect((await get('seaX100')).json().total).toBe(0)

    h.db.query('UPDATE assets SET deleted_at = ? WHERE id = ?').run(9_000, 'v000001')
    expect((await get('clip-1')).json().total).toBe(0)

    const oldSemantic = await h.app.inject({
      method: 'GET',
      url: '/api/search/semantic?q=clip',
      headers: h.headers,
    })
    expect(oldSemantic.statusCode).toBe(404)

    const unauthorized = await h.app.inject({ method: 'GET', url: '/api/assets?q=clip' })
    expect(unauthorized.statusCode).toBe(401)
  })

  test('neighbor returns the adjacent asset in list order', async () => {
    const h = await createHarness()
    const list = await h.app.inject({
      method: 'GET',
      url: '/api/assets?kind=video&sort=latest',
      headers: h.headers,
    })
    expect(list.statusCode).toBe(200)
    const ids = (list.json() as { items: { id: string }[] }).items.map((item) => item.id)
    expect(ids).toEqual(['v000005', 'v000004', 'v000003', 'v000002', 'v000001'])

    for (let index = 0; index < ids.length - 1; index += 1) {
      const next = await h.app.inject({
        method: 'GET',
        url: `/api/assets/${ids[index]}/neighbor?direction=next&kind=video&sort=latest`,
        headers: h.headers,
      })
      expect(next.statusCode).toBe(200)
      expect((next.json() as { asset: { id: string } }).asset.id).toBe(ids[index + 1]!)
    }

    const prev = await h.app.inject({
      method: 'GET',
      url: `/api/assets/${ids[3]}/neighbor?direction=prev&kind=video&sort=latest`,
      headers: h.headers,
    })
    expect((prev.json() as { asset: { id: string } }).asset.id).toBe(ids[2]!)
  })

  test('neighbor reports the ends, a missing anchor and a filtered anchor', async () => {
    const h = await createHarness()
    const atEnd = await h.app.inject({
      method: 'GET',
      url: '/api/assets/v000001/neighbor?direction=next&kind=video&sort=latest',
      headers: h.headers,
    })
    expect(atEnd.statusCode).toBe(204)

    const missing = await h.app.inject({
      method: 'GET',
      url: '/api/assets/nope0000/neighbor?direction=next&kind=video',
      headers: h.headers,
    })
    expect(missing.statusCode).toBe(404)

    const outside = await h.app.inject({
      method: 'GET',
      url: '/api/assets/i000001/neighbor?direction=next&kind=video',
      headers: h.headers,
    })
    expect(outside.statusCode).toBe(409)
    expect((outside.json() as { error: string }).error).toBe('anchor_not_in_filter')

    const bad = await h.app.inject({
      method: 'GET',
      url: '/api/assets/v000003/neighbor?direction=sideways&kind=video',
      headers: h.headers,
    })
    expect(bad.statusCode).toBe(400)
  })

  test('random stays inside the filter and avoids the current and recent assets', async () => {
    const h = await createHarness()
    for (const seed of [1, 2, 3, 4, 5]) {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/assets/random',
        headers: h.headers,
        payload: { kind: 'video', currentAssetId: 'v000005', recentIds: ['v000004'], seed },
      })
      expect(response.statusCode).toBe(200)
      const id = (response.json() as { asset: { id: string } }).asset.id
      expect(id).not.toBe('v000005')
      expect(id).not.toBe('v000004')
      expect(id).toStartWith('v')
    }
  })

  test('random returns 204 when the filter has no candidate', async () => {
    const h = await createHarness()
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/assets/random',
      headers: h.headers,
      payload: { folderId: 'folder0009' },
    })
    expect(response.statusCode).toBe(204)
  })

  test('navigation requires a session', async () => {
    const h = await createHarness()
    const neighbor = await h.app.inject({
      method: 'GET',
      url: '/api/assets/v000003/neighbor?direction=next',
    })
    expect(neighbor.statusCode).toBe(401)
    const random = await h.app.inject({ method: 'POST', url: '/api/assets/random', payload: {} })
    expect(random.statusCode).toBe(401)
  })
})
