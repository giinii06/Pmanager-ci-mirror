import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  claimNextJob,
  createLibrary,
  createUser,
  enqueueJob,
  getJob,
  getVoteActivityStats,
  insertAsset,
  openDatabase,
  pauseJob,
  recordVoteEvent,
  upsertFolder,
  type Db,
} from '@mediavault/database'
import { APP_VERSION } from '@mediavault/shared'
import { buildApp } from './app'
import { SESSION_COOKIE, createSession } from './auth'
import type { ApiConfig } from './config'
import type { AppContext } from './context'
import { Semaphore } from './semaphore'

const SECRET = 'fs-and-ops-test-secret'
const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function createHarness() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-api-fs-ops-'))
  dirs.push(dir)
  const mediaRoot = path.join(dir, 'media')
  const cacheDir = path.join(dir, 'cache')
  const dataDir = path.join(dir, 'data')
  await mkdir(path.join(mediaRoot, 'drives/c/Windows'), { recursive: true })
  await mkdir(path.join(mediaRoot, 'drives/c/$RECYCLE.BIN'), { recursive: true })
  await mkdir(path.join(mediaRoot, 'drives/c/Users/Public/Pictures'), { recursive: true })
  await mkdir(path.join(mediaRoot, 'drives/d/Media'), { recursive: true })
  await mkdir(path.join(mediaRoot, 'drives/e/Archive'), { recursive: true })
  await mkdir(cacheDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })

  // Also test symlink blocking inside browsable folder.
  await symlink('/tmp', path.join(mediaRoot, 'drives/d/EscapeLink'))

  const db = openDatabase(path.join(dataDir, 'mediavault.db'))
  createUser(db, { id: 'u1', username: 'owner', passwordHash: 'hash', createdAt: Date.now() })

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
    smartAlbumsEnabled: false,
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

  const ctx: AppContext = {
    config,
    db,
    thumbnails: new Semaphore(2),
    previews: new Semaphore(2),
  }
  const app = await buildApp(ctx)
  const token = createSession(db, 'u1', SECRET, { ttlMs: 3_600_000 }).token
  const cookie = `${SESSION_COOKIE}=${token}`

  return { dir, mediaRoot, db, app, cookie }
}

describe('FS explorer, security guards, health, backups, votes activity, and job controls', () => {
  test('unauthenticated health probes return 200 and full sqlite status', async () => {
    const h = await createHarness()
    for (const url of ['/health/live', '/api/health/live', '/health/ready', '/api/health/ready']) {
      const res = await h.app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(200)
      expect(res.json().ok).toBe(true)
    }
    const ready = await h.app.inject({ method: 'GET', url: '/health/ready' })
    expect(ready.json().synchronousMode).toBe('FULL')
    expect(ready.json().dbIntegrity).toBe('skipped')
    await h.app.close()
    h.db.close()
  })

  test('/api/health reports the shared APP_VERSION', async () => {
    const h = await createHarness()
    const res = await h.app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
    expect(res.json().version).toBe(APP_VERSION)
    await h.app.close()
    h.db.close()
  })

  test('fs/drives & fs/browse enforce traversal, UNC, symlink, and system folder blocks', async () => {
    const h = await createHarness()

    const drivesRes = await h.app.inject({
      method: 'GET',
      url: '/api/fs/drives',
      headers: { cookie: h.cookie },
    })
    expect(drivesRes.statusCode).toBe(200)
    const driveLabels = drivesRes.json().drives.map((d: { label: string }) => d.label)
    expect(driveLabels).toEqual(['C:\\', 'D:\\', 'E:\\'])

    const browseC = await h.app.inject({
      method: 'GET',
      url: '/api/fs/browse?path=drives/c',
      headers: { cookie: h.cookie },
    })
    expect(browseC.statusCode).toBe(200)
    const cNames = browseC.json().folders.map((f: { name: string }) => f.name)
    expect(cNames).toEqual(['Users'])
    expect(cNames).not.toContain('Windows')
    expect(cNames).not.toContain('$RECYCLE.BIN')

    for (const badPath of ['../secret', 'drives/d/../../etc', '\\\\server\\share', 'C:\\Windows']) {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/fs/browse?path=${encodeURIComponent(badPath)}`,
        headers: { cookie: h.cookie },
      })
      expect(res.statusCode).toBe(400)
    }

    for (const forbidden of ['drives/c/Windows', 'drives/c/$RECYCLE.BIN', 'drives/d/EscapeLink']) {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/fs/browse?path=${encodeURIComponent(forbidden)}`,
        headers: { cookie: h.cookie },
      })
      expect(res.statusCode).toBe(403)
    }

    const searchD = await h.app.inject({
      method: 'GET',
      url: '/api/fs/browse?path=drives/d&q=med',
      headers: { cookie: h.cookie },
    })
    expect(searchD.statusCode).toBe(200)
    expect(searchD.json().folders.map((f: { name: string }) => f.name)).toEqual(['Media'])

    await h.app.close()
    h.db.close()
  })

  test('POST /api/libraries blocks symlinks & system dirs and auto-queues initial scan', async () => {
    const h = await createHarness()

    const blockedSys = await h.app.inject({
      method: 'POST',
      url: '/api/libraries',
      headers: { cookie: h.cookie },
      payload: { name: 'Bad', rootPath: 'drives/c/Windows' },
    })
    expect(blockedSys.statusCode).toBe(403)

    const blockedLink = await h.app.inject({
      method: 'POST',
      url: '/api/libraries',
      headers: { cookie: h.cookie },
      payload: { name: 'Link', rootPath: 'drives/d/EscapeLink' },
    })
    expect(blockedLink.statusCode).toBe(403)

    const created = await h.app.inject({
      method: 'POST',
      url: '/api/libraries',
      headers: { cookie: h.cookie },
      payload: { name: 'My Media', rootPath: 'drives/d/Media' },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().scanState).toBe('queued')

    const jobsRes = await h.app.inject({
      method: 'GET',
      url: '/api/jobs',
      headers: { cookie: h.cookie },
    })
    expect(jobsRes.json().counts.queued).toBe(1)

    const dup = await h.app.inject({
      method: 'POST',
      url: '/api/libraries',
      headers: { cookie: h.cookie },
      payload: { name: 'Dup', rootPath: 'drives/d/Media' },
    })
    expect(dup.statusCode).toBe(409)

    await h.app.close()
    h.db.close()
  })

  test('votes-activity, system/status, manual backups, and job pause/resume/cancel work end-to-end', async () => {
    const h = await createHarness()
    createLibrary(h.db, { id: 'lib1', name: 'D Media', rootPath: 'drives/d/Media', createdAt: 100 })
    const fId = upsertFolder(h.db, {
      id: 'f1',
      libraryId: 'lib1',
      parentId: null,
      relativePath: '',
      name: 'Set 1',
      depth: 0,
      scanId: 's1',
    })
    const clipPath = path.join(h.mediaRoot, 'drives/d/Media/clip.mp4')
    await writeFile(clipPath, 'stub')
    insertAsset(h.db, {
      id: 'a1',
      libraryId: 'lib1',
      folderId: fId,
      relativePath: 'clip.mp4',
      filename: 'clip.mp4',
      kind: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 4,
      mtimeMs: 1000,
      width: 1920,
      height: 1080,
      durationMs: 10_000,
      takenAt: 1000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      container: 'mp4',
      indexedAt: 1000,
      scanId: 's1',
    })

    await h.app.inject({ method: 'POST', url: '/api/assets/a1/vote', headers: { cookie: h.cookie } })
    await h.app.inject({ method: 'POST', url: '/api/folders/f1/vote', headers: { cookie: h.cookie } })

    const voteStats = await h.app.inject({
      method: 'GET',
      url: '/api/stats/votes-activity',
      headers: { cookie: h.cookie },
    })
    expect(voteStats.statusCode).toBe(200)
    expect(voteStats.json().totalVotes).toBe(2)
    expect(voteStats.json().videoVotes).toBe(1)
    expect(voteStats.json().folderVotes).toBe(1)

    enqueueJob(h.db, { dedupeKey: 'scan:lib1', kind: 'scan_library', priority: 2, libraryId: 'lib1' }, 500)
    const jobRow = h.db.query<{ id: number }, []>('SELECT id FROM jobs ORDER BY id DESC LIMIT 1').get()!

    const paused = await h.app.inject({
      method: 'POST',
      url: `/api/jobs/${jobRow.id}/pause`,
      headers: { cookie: h.cookie },
    })
    expect(paused.statusCode).toBe(200)
    expect(paused.json().job.state).toBe('paused')

    const resumed = await h.app.inject({
      method: 'POST',
      url: `/api/jobs/${jobRow.id}/resume`,
      headers: { cookie: h.cookie },
    })
    expect(resumed.statusCode).toBe(200)
    expect(resumed.json().job.state).toBe('queued')

    const badResume = await h.app.inject({
      method: 'POST',
      url: `/api/jobs/${jobRow.id}/resume`,
      headers: { cookie: h.cookie },
    })
    expect(badResume.statusCode).toBe(409)

    const cancelled = await h.app.inject({
      method: 'POST',
      url: `/api/jobs/${jobRow.id}/cancel`,
      headers: { cookie: h.cookie },
    })
    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.json().job.state).toBe('cancelled')

    const backupPost = await h.app.inject({
      method: 'POST',
      url: '/api/backups',
      headers: { cookie: h.cookie },
    })
    expect(backupPost.statusCode).toBe(201)
    expect(backupPost.json().backup.integrity).toBe('ok')

    const statusRes = await h.app.inject({
      method: 'GET',
      url: '/api/system/status',
      headers: { cookie: h.cookie },
    })
    expect(statusRes.statusCode).toBe(200)
    const sys = statusRes.json()
    expect(sys.dbIntegrity).toBe('ok')
    expect(sys.synchronousMode).toBe('FULL')
    expect(sys.lastBackup.id).toBe(backupPost.json().backup.id)
    expect(sys.libraries[0].status).toBe('available')

    await h.app.close()
    h.db.close()
  })

  test('blocks symlink chains reaching system folders, pauses/resumes scans, and avoids storage double-counting', async () => {
    const h = await createHarness()
    await mkdir(path.join(h.mediaRoot, 'drives/c/Windows/System32'), { recursive: true })
    await symlink(path.join(h.mediaRoot, 'drives/c/Windows'), path.join(h.mediaRoot, 'drives/d/WinLink'))

    const deepBlocked = await h.app.inject({
      method: 'GET',
      url: '/api/fs/browse?path=drives/d/WinLink/System32',
      headers: { cookie: h.cookie },
    })
    expect(deepBlocked.statusCode).toBe(403)
    expect(deepBlocked.json().error).toBe('blocked_system_path')

    createLibrary(h.db, { id: 'lib-s', name: 'Sample', rootPath: 'drives/d/Media', createdAt: 100 })
    const fId = upsertFolder(h.db, {
      id: 'fs',
      libraryId: 'lib-s',
      parentId: null,
      relativePath: '',
      name: 'Media',
      depth: 0,
      scanId: 's1',
    })
    await writeFile(path.join(h.mediaRoot, 'drives/d/Media/vid.mp4'), '1234')
    await writeFile(path.join(h.mediaRoot, 'drives/d/Media/a.jpg'), 'img1')
    await writeFile(path.join(h.mediaRoot, 'drives/d/Media/readme.txt'), '0123456789')
    await writeFile(path.join(h.mediaRoot, 'drives/d/Media/partial.tmp'), 'x'.repeat(100))
    insertAsset(h.db, {
      id: 'vid1',
      libraryId: 'lib-s',
      folderId: fId,
      relativePath: 'vid.mp4',
      filename: 'vid.mp4',
      kind: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 4,
      mtimeMs: 1000,
      width: 640,
      height: 360,
      durationMs: 1000,
      takenAt: 1000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      container: 'mp4',
      indexedAt: 1000,
      scanId: 's1',
    })
    insertAsset(h.db, {
      id: 'img1',
      libraryId: 'lib-s',
      folderId: fId,
      relativePath: 'a.jpg',
      filename: 'a.jpg',
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 4,
      mtimeMs: 1000,
      width: 800,
      height: 1200,
      durationMs: null,
      takenAt: 1000,
      videoCodec: null,
      audioCodec: null,
      container: 'jpg',
      indexedAt: 1000,
      scanId: 's1',
    })

    const storageRes = await h.app.inject({
      method: 'GET',
      url: '/api/stats/storage?refresh=1',
      headers: { cookie: h.cookie },
    })
    expect(storageRes.statusCode).toBe(200)
    const storage = storageRes.json()
    expect(storage.videoBytes).toBe(4)
    expect(storage.imageBytes).toBe(4)
    expect(storage.tempBytes).toBe(100)
    expect(storage.totalLibraryBytes).toBe(18)

    const unauthCover = await h.app.inject({
      method: 'PUT',
      url: `/api/folders/${fId}/cover`,
      payload: { assetId: 'img1' },
    })
    expect(unauthCover.statusCode).toBe(401)

    const okCover = await h.app.inject({
      method: 'PUT',
      url: `/api/folders/${fId}/cover`,
      headers: { cookie: h.cookie },
      payload: { assetId: 'img1' },
    })
    expect(okCover.statusCode).toBe(200)
    expect(okCover.json().coverAssetId).toBe('img1')
    expect(okCover.json().coverWidth).toBe(800)
    expect(okCover.json().coverHeight).toBe(1200)

    const videoCover = await h.app.inject({
      method: 'PUT',
      url: `/api/folders/${fId}/cover`,
      headers: { cookie: h.cookie },
      payload: { assetId: 'vid1' },
    })
    expect(videoCover.statusCode).toBe(400)
    expect(videoCover.json().error).toBe('invalid_cover_asset')

    const missingFolderCover = await h.app.inject({
      method: 'PUT',
      url: '/api/folders/no-such-folder/cover',
      headers: { cookie: h.cookie },
      payload: { assetId: 'img1' },
    })
    expect(missingFolderCover.statusCode).toBe(404)

    enqueueJob(h.db, { dedupeKey: 'scan:lib-s', kind: 'scan_library', priority: 2, libraryId: 'lib-s' }, 100)
    const claimed = claimNextJob(h.db, 100, { workerId: 'w1', leaseMs: 10_000 })!
    pauseJob(h.db, claimed.id, 150)
    h.db.query("UPDATE jobs SET state = 'paused', worker_id = NULL, lease_expires_at = NULL WHERE id = ?").run(
      claimed.id,
    )

    const triggerRes = await h.app.inject({
      method: 'POST',
      url: '/api/libraries/lib-s/scan',
      headers: { cookie: h.cookie },
    })
    expect(triggerRes.statusCode).toBe(202)
    expect(getJob(h.db, claimed.id)?.state).toBe('queued')

    const kstMidnightPlusOne = Date.UTC(2026, 10, 17, 16, 0, 0)
    recordVoteEvent(h.db, 'asset', 'vid1', 'vid.mp4', kstMidnightPlusOne)
    const voteCal = getVoteActivityStats(h.db, kstMidnightPlusOne)
    expect(voteCal.days[voteCal.days.length - 1]?.date).toBe('2026-11-18')
    expect(voteCal.days[voteCal.days.length - 1]?.count).toBe(1)
    expect(voteCal.streakDays).toBe(1)

    await h.app.close()
    h.db.close()
  })
})

describe('library health', () => {
  test('reports unverified, online, missing, and empty states', async () => {
    const h = await createHarness()
    const libraryRoot = path.join(h.mediaRoot, 'Media')
    await mkdir(libraryRoot, { recursive: true })
    await writeFile(path.join(libraryRoot, 'photo.jpg'), 'x')
    createLibrary(h.db, { id: 'lib1', name: 'Media', rootPath: 'Media', createdAt: Date.now() })
    const folderId = upsertFolder(h.db, {
      id: 'f1',
      libraryId: 'lib1',
      parentId: null,
      relativePath: '',
      name: 'Media',
      depth: 0,
      scanId: 'seed',
    })
    insertAsset(h.db, {
      id: 'a1',
      libraryId: 'lib1',
      folderId,
      relativePath: 'photo.jpg',
      filename: 'photo.jpg',
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 1,
      mtimeMs: 1,
      width: 4,
      height: 4,
      durationMs: null,
      takenAt: 1,
      videoCodec: null,
      audioCodec: null,
      container: null,
      indexedAt: 1,
      scanId: 'seed',
    })

    const initial = await h.app.inject({
      method: 'GET',
      url: '/api/libraries',
      headers: { cookie: h.cookie },
    })
    expect(initial.json()[0].healthState).toBe('UNVERIFIED')

    const online = await h.app.inject({
      method: 'POST',
      url: '/api/libraries/lib1/verify',
      headers: { cookie: h.cookie },
    })
    expect(online.statusCode).toBe(200)
    expect(online.json()).toMatchObject({ state: 'ONLINE', lastSuccessAt: null })
    expect(online.json().rootIdentity).toBeTruthy()

    await rm(libraryRoot, { recursive: true, force: true })
    const missing = await h.app.inject({
      method: 'POST',
      url: '/api/libraries/lib1/verify',
      headers: { cookie: h.cookie },
    })
    expect(missing.json()).toMatchObject({ state: 'OFFLINE', lastErrorCode: 'root_missing' })

    await mkdir(libraryRoot, { recursive: true })
    const empty = await h.app.inject({
      method: 'POST',
      url: '/api/libraries/lib1/verify',
      headers: { cookie: h.cookie },
    })
    expect(empty.json()).toMatchObject({ state: 'OFFLINE', lastErrorCode: 'root_empty' })

    const health = await h.app.inject({
      method: 'GET',
      url: '/api/libraries/lib1/health',
      headers: { cookie: h.cookie },
    })
    expect(health.statusCode).toBe(200)
    expect(health.json()).toMatchObject({
      libraryId: 'lib1',
      state: 'OFFLINE',
      lastErrorCode: 'root_empty',
      consecutiveFailures: 2,
      scan: null,
    })

    const listed = await h.app.inject({
      method: 'GET',
      url: '/api/libraries',
      headers: { cookie: h.cookie },
    })
    expect(listed.json()[0]).toMatchObject({
      healthState: 'OFFLINE',
      healthErrorCode: 'root_empty',
      healthConsecutiveFailures: 2,
    })

    await h.app.close()
    h.db.close()
  })
})
