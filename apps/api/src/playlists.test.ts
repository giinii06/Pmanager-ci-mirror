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
import type { PlaylistDTO, PlaylistDetailDTO, PlaylistItemDTO } from '@mediavault/shared'
import { buildApp } from './app'
import { SESSION_COOKIE, createSession } from './auth'
import type { ApiConfig } from './config'
import type { AppContext } from './context'
import { Semaphore } from './semaphore'

const SECRET = 'playlists-test-secret'
const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function createHarness() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-api-playlists-'))
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
  for (const [id, size] of [
    ['vid001', 1_000],
    ['vid002', 2_000],
    ['vid003', 3_000],
  ] as const) {
    insertAsset(db, {
      id,
      libraryId: 'lib1',
      folderId,
      relativePath: `${id}.mp4`,
      filename: `${id}.mp4`,
      kind: 'video',
      mimeType: 'video/mp4',
      sizeBytes: size,
      mtimeMs: 1_000,
      width: 100,
      height: 100,
      durationMs: 60_000,
      takenAt: size,
      videoCodec: null,
      audioCodec: null,
      container: 'mp4',
      indexedAt: size,
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

async function createPlaylist(harness: Harness, payload: Record<string, unknown>): Promise<PlaylistDTO> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/playlists',
    headers: harness.headers,
    payload,
  })
  expect(response.statusCode).toBe(201)
  return response.json() as PlaylistDTO
}

async function addItem(harness: Harness, playlistId: string, assetId: string): Promise<PlaylistItemDTO> {
  const response = await harness.app.inject({
    method: 'POST',
    url: `/api/playlists/${playlistId}/items`,
    headers: harness.headers,
    payload: { assetId },
  })
  expect(response.statusCode).toBe(201)
  return (response.json() as { item: PlaylistItemDTO }).item
}

async function readDetail(harness: Harness, playlistId: string): Promise<PlaylistDetailDTO> {
  const response = await harness.app.inject({
    method: 'GET',
    url: `/api/playlists/${playlistId}`,
    headers: harness.headers,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as PlaylistDetailDTO
}

describe('playlist API', () => {
  test('every route requires a session', async () => {
    const harness = await createHarness()
    for (const [method, url] of [
      ['GET', '/api/playlists'],
      ['POST', '/api/playlists'],
      ['GET', '/api/playlists/abc'],
      ['PATCH', '/api/playlists/abc'],
      ['DELETE', '/api/playlists/abc'],
      ['GET', '/api/playlists/abc/assets'],
      ['POST', '/api/playlists/abc/items'],
      ['PATCH', '/api/playlists/abc/items/xyz'],
      ['DELETE', '/api/playlists/abc/items/xyz'],
      ['POST', '/api/playlists/watch-later'],
      ['POST', '/api/playlists/watch-later/items'],
    ] as const) {
      const response = await harness.app.inject({
        method,
        url,
        payload: method === 'GET' || method === 'DELETE' ? undefined : { name: 'x', assetId: 'vid001', position: 0 },
      })
      expect(response.statusCode).toBe(401)
    }
  })

  test('a playlist is created, listed, read, renamed and deleted', async () => {
    const harness = await createHarness()
    const created = await createPlaylist(harness, { name: '  Road trip  ', description: 'summer' })
    expect(created).toMatchObject({
      name: 'Road trip',
      description: 'summer',
      kind: 'custom',
      itemCount: 0,
      availableCount: 0,
    })

    const list = await harness.app.inject({ method: 'GET', url: '/api/playlists', headers: harness.headers })
    expect((list.json() as { playlists: PlaylistDTO[] }).playlists.map((entry) => entry.id)).toEqual([created.id])

    const detail = await readDetail(harness, created.id)
    expect(detail.playlist.name).toBe('Road trip')
    expect(detail.items).toEqual([])

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/playlists/${created.id}`,
      headers: harness.headers,
      payload: { name: 'Road trip 2026' },
    })
    expect(patched.statusCode).toBe(200)
    expect((patched.json() as PlaylistDTO)).toMatchObject({ name: 'Road trip 2026', description: 'summer' })

    const removed = await harness.app.inject({
      method: 'DELETE',
      url: `/api/playlists/${created.id}`,
      headers: harness.headers,
    })
    expect(removed.statusCode).toBe(204)
    const gone = await harness.app.inject({
      method: 'GET',
      url: `/api/playlists/${created.id}`,
      headers: harness.headers,
    })
    expect(gone.statusCode).toBe(404)
  })

  test('a duplicate name is a 409 and a bad name is a 400', async () => {
    const harness = await createHarness()
    await createPlaylist(harness, { name: 'Trips' })

    const duplicate = await harness.app.inject({
      method: 'POST',
      url: '/api/playlists',
      headers: harness.headers,
      payload: { name: 'trips' },
    })
    expect(duplicate.statusCode).toBe(409)
    expect((duplicate.json() as { error: string }).error).toBe('name_taken')

    for (const payload of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(81) }, { name: 'ok', description: 'y'.repeat(501) }]) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/playlists',
        headers: harness.headers,
        payload,
      })
      expect(response.statusCode).toBe(400)
      expect((response.json() as { error: string }).error).toBe('invalid_request')
    }

    const emptyPatch = await harness.app.inject({
      method: 'PATCH',
      url: `/api/playlists/${(await createPlaylist(harness, { name: 'Other' })).id}`,
      headers: harness.headers,
      payload: {},
    })
    expect(emptyPatch.statusCode).toBe(400)
  })

  test('items append, reorder, remove and serve their assets', async () => {
    const harness = await createHarness()
    const playlist = await createPlaylist(harness, { name: 'Queue' })
    const first = await addItem(harness, playlist.id, 'vid001')
    const second = await addItem(harness, playlist.id, 'vid002')
    const third = await addItem(harness, playlist.id, 'vid003')
    expect([first.position, second.position, third.position]).toEqual([0, 1, 2])
    expect(first.available).toBe(true)

    const assets = await harness.app.inject({
      method: 'GET',
      url: `/api/playlists/${playlist.id}/assets`,
      headers: harness.headers,
    })
    expect(assets.statusCode).toBe(200)
    const assetsBody = assets.json() as { playlist: PlaylistDTO; items: Array<{ id: string }> }
    expect(assetsBody.playlist.itemCount).toBe(3)
    expect(assetsBody.items.map((asset) => asset.id)).toEqual(['vid001', 'vid002', 'vid003'])

    const moved = await harness.app.inject({
      method: 'PATCH',
      url: `/api/playlists/${playlist.id}/items/${first.id}`,
      headers: harness.headers,
      payload: { position: 2 },
    })
    expect(moved.statusCode).toBe(200)
    const movedBody = moved.json() as PlaylistDetailDTO
    expect(movedBody.items.map((item) => item.id)).toEqual([second.id, third.id, first.id])
    expect(movedBody.items.map((item) => item.position)).toEqual([0, 1, 2])

    const removed = await harness.app.inject({
      method: 'DELETE',
      url: `/api/playlists/${playlist.id}/items/${second.id}`,
      headers: harness.headers,
    })
    expect(removed.statusCode).toBe(204)
    expect((await readDetail(harness, playlist.id)).items.map((item) => item.assetId)).toEqual(['vid003', 'vid001'])
  })

  test('the watch later list can be opened before it has items', async () => {
    const harness = await createHarness()
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/playlists/watch-later',
      headers: harness.headers,
    })
    expect(first.statusCode).toBe(200)
    const firstBody = first.json() as { playlist: PlaylistDTO }
    expect(firstBody.playlist).toMatchObject({ kind: 'watch_later', name: '나중에 보기', itemCount: 0 })

    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/playlists/watch-later',
      headers: harness.headers,
    })
    expect((second.json() as { playlist: PlaylistDTO }).playlist.id).toBe(firstBody.playlist.id)

    const list = await harness.app.inject({ method: 'GET', url: '/api/playlists', headers: harness.headers })
    expect((list.json() as { playlists: PlaylistDTO[] }).playlists).toHaveLength(1)
  })

  test('watch later is created on first use and reused after', async () => {
    const harness = await createHarness()
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/playlists/watch-later/items',
      headers: harness.headers,
      payload: { assetId: 'vid002' },
    })
    expect(first.statusCode).toBe(201)
    const firstBody = first.json() as { playlist: PlaylistDTO; item: PlaylistItemDTO }
    expect(firstBody.playlist.kind).toBe('watch_later')
    expect(firstBody.playlist.name).toBe('나중에 보기')
    expect(firstBody.item).toMatchObject({ assetId: 'vid002', position: 0 })

    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/playlists/watch-later/items',
      headers: harness.headers,
      payload: { assetId: 'vid001' },
    })
    const secondBody = second.json() as { playlist: PlaylistDTO; item: PlaylistItemDTO }
    expect(secondBody.playlist.id).toBe(firstBody.playlist.id)
    expect(secondBody.item.position).toBe(1)

    const list = await harness.app.inject({ method: 'GET', url: '/api/playlists', headers: harness.headers })
    const playlists = (list.json() as { playlists: PlaylistDTO[] }).playlists
    expect(playlists).toHaveLength(1)
    expect(playlists[0]).toMatchObject({ kind: 'watch_later', itemCount: 2 })
  })

  test('a missing asset is a 404 and a foreign id is a 404', async () => {
    const harness = await createHarness()
    const playlist = await createPlaylist(harness, { name: 'Queue' })

    const missingAsset = await harness.app.inject({
      method: 'POST',
      url: `/api/playlists/${playlist.id}/items`,
      headers: harness.headers,
      payload: { assetId: 'doesnotexist' },
    })
    expect(missingAsset.statusCode).toBe(404)
    expect((missingAsset.json() as { error: string }).error).toBe('asset_not_found')

    const item = await addItem(harness, playlist.id, 'vid001')
    for (const [method, url, payload] of [
      ['GET', `/api/playlists/${playlist.id}`, undefined],
      ['GET', `/api/playlists/${playlist.id}/assets`, undefined],
      ['PATCH', `/api/playlists/${playlist.id}`, { name: 'Stolen' }],
      ['DELETE', `/api/playlists/${playlist.id}`, undefined],
      ['POST', `/api/playlists/${playlist.id}/items`, { assetId: 'vid002' }],
      ['PATCH', `/api/playlists/${playlist.id}/items/${item.id}`, { position: 0 }],
      ['DELETE', `/api/playlists/${playlist.id}/items/${item.id}`, undefined],
    ] as const) {
      const response = await harness.app.inject({ method, url, headers: harness.guest, payload })
      expect(response.statusCode).toBe(404)
    }

    const guestList = await harness.app.inject({ method: 'GET', url: '/api/playlists', headers: harness.guest })
    expect((guestList.json() as { playlists: PlaylistDTO[] }).playlists).toEqual([])
    // The owner's list is intact after the guest's attempts.
    expect((await readDetail(harness, playlist.id)).items).toHaveLength(1)
  })

  test('a soft-deleted asset keeps its slot and reports as unavailable', async () => {
    const harness = await createHarness()
    const playlist = await createPlaylist(harness, { name: 'Queue' })
    await addItem(harness, playlist.id, 'vid001')
    await addItem(harness, playlist.id, 'vid002')
    harness.db
      .query<null, [number, string]>('UPDATE assets SET deleted_at = ? WHERE id = ?')
      .run(500, 'vid001')

    const detail = await readDetail(harness, playlist.id)
    expect(detail.items).toMatchObject([
      { assetId: 'vid001', available: false },
      { assetId: 'vid002', available: true },
    ])
    expect(detail.playlist).toMatchObject({ itemCount: 2, availableCount: 1 })

    const assets = await harness.app.inject({
      method: 'GET',
      url: `/api/playlists/${playlist.id}/assets`,
      headers: harness.headers,
    })
    expect((assets.json() as { items: Array<{ id: string }> }).items.map((asset) => asset.id)).toEqual(['vid002'])
  })
})
