import { afterAll, describe, expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import {
  createLibrary,
  createUser,
  insertAsset,
  markLibraryHealthy,
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

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function createTestHarness() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-api-overhaul-'))
  dirs.push(dir)
  const mediaRoot = path.join(dir, 'media')
  const cacheDir = path.join(dir, 'cache')
  const asrDir = path.join(dir, 'asr')
  const trDir = path.join(dir, 'tr')
  await mkdir(path.join(mediaRoot, 'Videos'), { recursive: true })
  await mkdir(path.join(mediaRoot, 'Photos/Set1'), { recursive: true })
  await mkdir(cacheDir, { recursive: true })
  await mkdir(asrDir, { recursive: true })
  await mkdir(trDir, { recursive: true })

  const videoPath = path.join(mediaRoot, 'Videos', 'vid1.mp4')
  const gen = Bun.spawnSync([
    'ffmpeg',
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=160x120:r=10:d=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    videoPath,
  ])
  if (gen.exitCode !== 0) throw new Error(gen.stderr.toString())

  const vid2Path = path.join(mediaRoot, 'Videos', 'vid2.mp4')
  await writeFile(vid2Path, 'dummy-video-bytes')

  const photoPath = path.join(mediaRoot, 'Photos/Set1', 'p1.jpg')
  await sharp({
    create: { width: 40, height: 40, channels: 3, background: { r: 20, g: 40, b: 200 } },
  })
    .jpeg()
    .toFile(photoPath)

  const db: Db = openDatabase(':memory:')
  createUser(db, { id: 'user1', username: 'owner', passwordHash: 'x', createdAt: 1 })
  createLibrary(db, { id: 'libv', name: 'Videos', rootPath: 'Videos', createdAt: 1 })
  createLibrary(db, { id: 'libp', name: 'Photos', rootPath: 'Photos', createdAt: 1 })
  markLibraryHealthy(db, { libraryId: 'libv', rootIdentity: null, now: Date.now() })
  markLibraryHealthy(db, { libraryId: 'libp', rootIdentity: null, now: Date.now() })
  upsertFolder(db, {
    id: 'fv1',
    libraryId: 'libv',
    parentId: null,
    relativePath: '',
    name: 'Videos',
    depth: 0,
    scanId: 's1',
    createdAt: 100,
  })
  upsertFolder(db, {
    id: 'fp1',
    libraryId: 'libp',
    parentId: null,
    relativePath: 'Set1',
    name: 'Set1',
    depth: 1,
    scanId: 's1',
    createdAt: 200,
  })

  insertAsset(db, {
    id: 'vid0001',
    libraryId: 'libv',
    folderId: 'fv1',
    relativePath: 'vid1.mp4',
    filename: 'vid1.mp4',
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 2000,
    mtimeMs: 1000,
    width: 160,
    height: 120,
    durationMs: 2000,
    takenAt: 1000,
    videoCodec: 'h264',
    audioCodec: null,
    container: 'mp4',
    indexedAt: Date.now(),
    scanId: 's1',
  })
  insertAsset(db, {
    id: 'vid0002',
    libraryId: 'libv',
    folderId: 'fv1',
    relativePath: 'vid2.mp4',
    filename: 'alpha.mp4',
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 1500,
    mtimeMs: 2000,
    width: 160,
    height: 120,
    durationMs: 2000,
    takenAt: 2000,
    videoCodec: 'h264',
    audioCodec: null,
    container: 'mp4',
    indexedAt: Date.now(),
    scanId: 's1',
  })
  insertAsset(db, {
    id: 'img0001',
    libraryId: 'libp',
    folderId: 'fp1',
    relativePath: 'Set1/p1.jpg',
    filename: 'p1.jpg',
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 500,
    mtimeMs: 1000,
    width: 40,
    height: 40,
    durationMs: null,
    takenAt: 1000,
    videoCodec: null,
    audioCodec: null,
    container: null,
    indexedAt: Date.now(),
    scanId: 's1',
  })

  const config: ApiConfig = {
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    cacheDir,
    mediaRoot,
    authSecret: SECRET,
    accel: false,
    hwaccel: null,
    secureCookies: false,
    scanIntervalMs: 60_000,
    fileMutationEnabled: true,
    hlsGenerationsEnabled: false,
    trustProxy: [],
    publicOrigins: [],
    gpu: { resourceId: 'gpu:0' },
    asr: {
      enabled: false,
      workerToken: '',
      resultDir: asrDir,
      modelRevision: 'asr',
      alignerRevision: 'align',
      pipelineVersion: '1',
      retryMs: 60_000,
    },
    translation: {
      enabled: false,
      workerToken: '',
      resultDir: trDir,
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
      queryUrl: 'http://127.0.0.1:1',
    },
  }

  const ctx: AppContext = { db, config, thumbnails: new Semaphore(1), previews: new Semaphore(1) }
  const app = await buildApp(ctx)
  const cookie = `${SESSION_COOKIE}=${createSession(db, 'user1', SECRET).token}`
  return { app, db, mediaRoot, cacheDir, videoPath, headers: { cookie } }
}

describe('API overhaul routes', () => {
  test('tracks views, watch time, cumulative votes, Rate, sorts, and asset ids', async () => {
    const h = await createTestHarness()

    await h.app.inject({ method: 'POST', url: '/api/assets/vid0001/view', headers: h.headers })
    await h.app.inject({
      method: 'POST',
      url: '/api/assets/vid0001/watch-time',
      headers: h.headers,
      payload: { deltaMs: 12_000 },
    })
    await h.app.inject({ method: 'POST', url: '/api/assets/vid0001/vote', headers: h.headers })
    const voted = await h.app.inject({ method: 'POST', url: '/api/assets/vid0001/vote', headers: h.headers })
    expect(voted.statusCode).toBe(200)
    expect(voted.json()).toMatchObject({
      viewCount: 1,
      watchTimeMs: 12_000,
      voteCount: 2,
      rate: 50,
    })

    const feed = await h.app.inject({
      method: 'GET',
      url: '/api/assets?kind=video',
      headers: h.headers,
    })
    expect(feed.statusCode).toBe(200)
    expect((feed.json() as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual([
      'vid0001',
      'vid0002',
    ])

    await h.app.inject({ method: 'POST', url: '/api/assets/vid0002/view', headers: h.headers })
    await h.app.inject({ method: 'POST', url: '/api/assets/vid0002/view', headers: h.headers })
    await h.app.inject({
      method: 'POST',
      url: '/api/assets/vid0002/watch-time',
      headers: h.headers,
      payload: { deltaMs: 2_000 },
    })
    for (let i = 0; i < 4; i += 1) {
      await h.app.inject({ method: 'POST', url: '/api/assets/vid0002/vote', headers: h.headers })
    }

    const assertOrder = async (sort: string, expected: string[]) => {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/assets?kind=video&sort=${sort}`,
        headers: h.headers,
      })
      expect(res.statusCode).toBe(200)
      expect((res.json() as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual(expected)
    }

    await assertOrder('views', ['vid0002', 'vid0001'])
    await assertOrder('watch_time', ['vid0001', 'vid0002'])
    await assertOrder('votes', ['vid0002', 'vid0001'])
    await assertOrder('latest', ['vid0002', 'vid0001'])

    const byName = await h.app.inject({
      method: 'GET',
      url: '/api/assets/ids?kind=video&sort=name',
      headers: h.headers,
    })
    expect((byName.json() as { ids: string[] }).ids).toEqual(['vid0002', 'vid0001'])

    h.db.close()
  })

  test('manages tags, captures custom thumbnail with cache bust, and permanently deletes', async () => {
    const h = await createTestHarness()

    const createdTag = await h.app.inject({
      method: 'POST',
      url: '/api/tags',
      headers: h.headers,
      payload: { name: 'Dance' },
    })
    expect(createdTag.statusCode).toBe(201)
    const tagId = (createdTag.json() as { tag: { id: string } }).tag.id

    const attached = await h.app.inject({
      method: 'POST',
      url: '/api/assets/vid0001/tags',
      headers: h.headers,
      payload: { tagId },
    })
    expect(attached.statusCode).toBe(200)

    const attachedByName = await h.app.inject({
      method: 'POST',
      url: '/api/assets/vid0001/tags',
      headers: h.headers,
      payload: { name: 'StageCam' },
    })
    expect(attachedByName.statusCode).toBe(200)
    const byNameTags = (attachedByName.json() as { asset: { tags: Array<{ id: string; name: string }> } })
      .asset.tags
    const stageTag = byNameTags.find((t) => t.name === 'StageCam')
    expect(stageTag).toBeTruthy()

    const renamed = await h.app.inject({
      method: 'PATCH',
      url: `/api/tags/${stageTag!.id}`,
      headers: h.headers,
      payload: { name: 'FocusCam' },
    })
    expect(renamed.statusCode).toBe(200)
    expect((renamed.json() as { tag: { name: string } }).tag.name).toBe('FocusCam')

    const detached = await h.app.inject({
      method: 'DELETE',
      url: `/api/assets/vid0001/tags/${stageTag!.id}`,
      headers: h.headers,
    })
    expect(detached.statusCode).toBe(200)
    expect(
      (detached.json() as { asset: { tags: Array<{ id: string }> } }).asset.tags.some(
        (t) => t.id === stageTag!.id,
      ),
    ).toBe(false)

    const deletedTag = await h.app.inject({
      method: 'DELETE',
      url: `/api/tags/${stageTag!.id}`,
      headers: h.headers,
    })
    expect(deletedTag.statusCode).toBe(204)
    const tagList = await h.app.inject({ method: 'GET', url: '/api/tags', headers: h.headers })
    expect(
      (tagList.json() as { tags: Array<{ id: string }> }).tags.some((t) => t.id === stageTag!.id),
    ).toBe(false)

    const imgThumb = await h.app.inject({
      method: 'GET',
      url: '/api/assets/img0001/thumbnail?size=320&pv=1',
      headers: h.headers,
    })
    expect(imgThumb.statusCode).toBe(200)
    expect(imgThumb.headers['content-type']).toMatch(/^image\//)
    expect(imgThumb.rawPayload.length).toBeGreaterThan(0)

    const captured = await h.app.inject({
      method: 'POST',
      url: '/api/assets/vid0001/thumbnail',
      headers: h.headers,
      payload: { positionMs: 500 },
    })
    expect(captured.statusCode).toBe(200)
    const capBody = captured.json() as { asset: { posterVersion: number; thumbnails: { medium: string } } }
    expect(capBody.asset.posterVersion).toBe(2)
    expect(capBody.asset.thumbnails.medium).toContain('&pv=2')

    const thumbV2 = await h.app.inject({
      method: 'GET',
      url: '/api/assets/vid0001/thumbnail?size=320&pv=2',
      headers: h.headers,
    })
    expect(thumbV2.statusCode).toBe(200)
    expect(thumbV2.headers['content-type']).toMatch(/^image\//)
    expect(thumbV2.rawPayload.length).toBeGreaterThan(0)

    const recaptured = await h.app.inject({
      method: 'POST',
      url: '/api/assets/vid0001/thumbnail',
      headers: h.headers,
      payload: { positionMs: 1000 },
    })
    expect(recaptured.statusCode).toBe(200)
    expect((recaptured.json() as { asset: { posterVersion: number } }).asset.posterVersion).toBe(3)

    const thumbV3 = await h.app.inject({
      method: 'GET',
      url: '/api/assets/vid0001/thumbnail?size=320&pv=3',
      headers: h.headers,
    })
    expect(thumbV3.statusCode).toBe(200)
    expect(thumbV3.headers['content-type']).toMatch(/^image\//)
    expect(thumbV3.rawPayload.length).toBeGreaterThan(0)

    const deleted = await h.app.inject({
      method: 'DELETE',
      url: '/api/assets/vid0001',
      headers: h.headers,
    })
    expect(deleted.statusCode).toBe(202)
    const operation = deleted.json() as { id: string; state: string; statusUrl: string }
    expect(operation.state).toBe('requested')
    expect(operation.statusUrl).toBe(`/api/file-operations/${operation.id}`)

    // The API only queues the delete. The mutation worker owns the original
    // file and the derived cache, so neither may change here.
    expect(await exists(h.videoPath)).toBe(true)
    expect(await exists(path.join(h.cacheDir, 'thumbs', 'vid0001'))).toBe(true)

    const repeated = await h.app.inject({
      method: 'DELETE',
      url: '/api/assets/vid0001',
      headers: h.headers,
    })
    expect(repeated.statusCode).toBe(202)
    expect((repeated.json() as { id: string }).id).toBe(operation.id)

    const fetched = await h.app.inject({
      method: 'GET',
      url: operation.statusUrl,
      headers: h.headers,
    })
    expect(fetched.statusCode).toBe(200)
    expect((fetched.json() as { state: string }).state).toBe('requested')

    h.db.close()
  })

  test('sorts photo folders by votes, name, and date', async () => {
    const h = await createTestHarness()

    const alphaDir = path.join(h.mediaRoot, 'Photos', 'Alpha')
    await mkdir(alphaDir, { recursive: true })
    await sharp({
      create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 40, b: 20 } },
    })
      .jpeg()
      .toFile(path.join(alphaDir, 'a1.jpg'))

    upsertFolder(h.db, {
      id: 'fp2',
      libraryId: 'libp',
      parentId: null,
      relativePath: 'Alpha',
      name: 'Alpha',
      depth: 1,
      scanId: 's1',
      createdAt: 500,
    })
    insertAsset(h.db, {
      id: 'img0002',
      libraryId: 'libp',
      folderId: 'fp2',
      relativePath: 'Alpha/a1.jpg',
      filename: 'a1.jpg',
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 500,
      mtimeMs: 2000,
      width: 40,
      height: 40,
      durationMs: null,
      takenAt: 2000,
      videoCodec: null,
      audioCodec: null,
      container: null,
      indexedAt: Date.now(),
      scanId: 's1',
    })

    await h.app.inject({ method: 'POST', url: '/api/folders/fp1/vote', headers: h.headers })
    await h.app.inject({ method: 'POST', url: '/api/folders/fp1/vote', headers: h.headers })
    await h.app.inject({ method: 'POST', url: '/api/folders/fp2/vote', headers: h.headers })

    const assertFolderOrder = async (sort: string, expected: string[]) => {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/folders?libraryId=libp&sort=${sort}`,
        headers: h.headers,
      })
      expect(res.statusCode).toBe(200)
      expect((res.json() as Array<{ id: string }>).map((f) => f.id)).toEqual(expected)
    }

    await assertFolderOrder('votes', ['fp1', 'fp2'])
    await assertFolderOrder('name', ['fp2', 'fp1'])
    await assertFolderOrder('date', ['fp2', 'fp1'])

    h.db.close()
  })

  test('tracks photo views on folder summary, folder votes, stats activity and storage', async () => {
    const h = await createTestHarness()

    await h.app.inject({ method: 'POST', url: '/api/assets/img0001/view', headers: h.headers })
    await h.app.inject({ method: 'POST', url: '/api/folders/fp1/vote', headers: h.headers })

    const foldersRes = await h.app.inject({
      method: 'GET',
      url: '/api/folders?sort=views',
      headers: h.headers,
    })
    expect(foldersRes.statusCode).toBe(200)
    const fp1 = (foldersRes.json() as Array<{ id: string; viewCount: number; voteCount: number }>).find(
      (f) => f.id === 'fp1',
    )
    expect(fp1).toMatchObject({ viewCount: 1, voteCount: 1 })

    const activityRes = await h.app.inject({
      method: 'GET',
      url: '/api/stats/activity',
      headers: h.headers,
    })
    expect(activityRes.statusCode).toBe(200)
    expect((activityRes.json() as { totalCount: number; days: unknown[] }).totalCount).toBe(3)
    expect((activityRes.json() as { days: unknown[] }).days).toHaveLength(365)

    const archivesRes = await h.app.inject({
      method: 'GET',
      url: '/api/archives',
      headers: h.headers,
    })
    expect(archivesRes.statusCode).toBe(200)
    expect((archivesRes.json() as { archives: unknown[] }).archives).toEqual([])

    const statsRes = await h.app.inject({
      method: 'GET',
      url: '/api/stats',
      headers: h.headers,
    })
    expect(statsRes.statusCode).toBe(200)
    expect(statsRes.json()).toMatchObject({ assets: 3, images: 1, videos: 2, folders: 2 })

    const storageRes = await h.app.inject({
      method: 'GET',
      url: '/api/stats/storage?refresh=1',
      headers: h.headers,
    })
    expect(storageRes.statusCode).toBe(200)
    const storage = storageRes.json() as { totalLibraryBytes: number; videoBytes: number; imageBytes: number }
    expect(storage.totalLibraryBytes).toBeGreaterThan(0)
    expect(storage.videoBytes).toBeGreaterThan(0)
    expect(storage.imageBytes).toBeGreaterThan(0)

    h.db.close()
  })
})
