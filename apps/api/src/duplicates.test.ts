import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createLibrary,
  createUser,
  insertAsset,
  openDatabase,
  replaceDuplicateGroups,
  upsertFolder,
  type Db,
} from '@mediavault/database'
import type { DuplicateGroupDTO, DuplicateGroupListDTO } from '@mediavault/shared'
import { buildApp } from './app'
import { SESSION_COOKIE, createSession } from './auth'
import type { ApiConfig } from './config'
import type { AppContext } from './context'
import { Semaphore } from './semaphore'

const SECRET = 'duplicates-test-secret'
const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function createHarness() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-api-duplicates-'))
  dirs.push(dir)
  const mediaRoot = path.join(dir, 'media')
  const cacheDir = path.join(dir, 'cache')
  const dataDir = path.join(dir, 'data')
  await mkdir(path.join(mediaRoot, 'Lib'), { recursive: true })
  await mkdir(cacheDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })

  const db: Db = openDatabase(path.join(dataDir, 'mediavault.db'))
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
  for (const [index, name] of ['one.mp4', 'two.mp4', 'three.mp4'].entries()) {
    insertAsset(db, {
      id: `a${index + 1}`,
      libraryId: 'lib1',
      folderId,
      relativePath: name,
      filename: name,
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
  const headers = { cookie: `${SESSION_COOKIE}=${token}` }
  return { app, db, headers }
}

function seedGroups(db: Db): void {
  const members = [
    { assetId: 'a1', confidence: 1, sameInode: false },
    { assetId: 'a2', confidence: 1, sameInode: false },
  ]
  const groups = ['a', 'b', 'c'].map((suffix) => ({
    fingerprint: `sha256:2048:${suffix.repeat(64)}`,
    members,
  }))
  replaceDuplicateGroups(db, 'exact', groups, 300)
  // One call stamps every group with the same time, so the fixture spaces them
  // out to give the cursor three distinct positions.
  for (const [index, suffix] of ['a', 'b', 'c'].entries()) {
    db.query<null, [number, string]>(
      'UPDATE duplicate_groups SET created_at = ? WHERE fingerprint = ?',
    ).run(100 * (index + 1), `sha256:2048:${suffix.repeat(64)}`)
  }
}

describe('duplicate routes', () => {
  test('a scan request queues one maintenance job and a repeat joins it', async () => {
    const h = await createHarness()

    const first = await h.app.inject({
      method: 'POST',
      url: '/api/duplicates/scans',
      headers: h.headers,
      payload: { libraryId: 'lib1' },
    })
    expect(first.statusCode).toBe(202)
    const body = first.json() as { jobId: number; dedupeKey: string; state: string }
    expect(body.dedupeKey).toBe('duplicates:lib1')
    expect(body.state).toBe('queued')

    const second = await h.app.inject({
      method: 'POST',
      url: '/api/duplicates/scans',
      headers: h.headers,
      payload: { libraryId: 'lib1' },
    })
    expect(second.statusCode).toBe(202)
    expect((second.json() as { jobId: number }).jobId).toBe(body.jobId)

    const jobs = h.db
      .query<{ kind: string; priority: number; payload: string }, []>(
        'SELECT kind, priority, payload FROM jobs',
      )
      .all()
    expect(jobs).toEqual([
      { kind: 'maintenance', priority: 4, payload: JSON.stringify({ task: 'duplicates' }) },
    ])

    const missing = await h.app.inject({
      method: 'POST',
      url: '/api/duplicates/scans',
      headers: h.headers,
      payload: { libraryId: 'nope' },
    })
    expect(missing.statusCode).toBe(404)
    h.db.close()
  })

  test('the list filters by state and pages through the newest first', async () => {
    const h = await createHarness()
    seedGroups(h.db)

    const all = await h.app.inject({
      method: 'GET',
      url: '/api/duplicates/groups?limit=10&state=all',
      headers: h.headers,
    })
    expect(all.statusCode).toBe(200)
    const page = all.json() as DuplicateGroupListDTO
    expect(page.groups).toHaveLength(3)
    expect(page.nextCursor).toBeNull()
    expect(page.groups.map((group) => group.fingerprint.slice(-1))).toEqual(['c', 'b', 'a'])
    expect(page.groups[0]!.memberCount).toBe(2)

    const kept = await h.app.inject({
      method: 'GET',
      url: '/api/duplicates/groups?state=kept',
      headers: h.headers,
    })
    expect((kept.json() as DuplicateGroupListDTO).groups).toEqual([])

    const similar = await h.app.inject({
      method: 'GET',
      url: '/api/duplicates/groups?kind=similar',
      headers: h.headers,
    })
    expect(similar.json()).toEqual({ groups: [], nextCursor: null })

    const first = await h.app.inject({
      method: 'GET',
      url: '/api/duplicates/groups?limit=2',
      headers: h.headers,
    })
    const firstPage = first.json() as DuplicateGroupListDTO
    expect(firstPage.groups).toHaveLength(2)
    expect(firstPage.nextCursor).not.toBeNull()

    const second = await h.app.inject({
      method: 'GET',
      url: `/api/duplicates/groups?limit=2&cursor=${firstPage.nextCursor}`,
      headers: h.headers,
    })
    const secondPage = second.json() as DuplicateGroupListDTO
    expect(secondPage.groups).toHaveLength(1)
    expect(secondPage.nextCursor).toBeNull()
    expect(secondPage.groups[0]!.fingerprint).not.toBe(firstPage.groups[0]!.fingerprint)

    const broken = await h.app.inject({
      method: 'GET',
      url: '/api/duplicates/groups?cursor=not-a-cursor',
      headers: h.headers,
    })
    expect(broken.statusCode).toBe(400)
    h.db.close()
  })

  test('a group detail carries the member fields the page needs', async () => {
    const h = await createHarness()
    seedGroups(h.db)
    const id = h.db.query<{ id: string }, []>('SELECT id FROM duplicate_groups LIMIT 1').get()!.id

    const detail = await h.app.inject({
      method: 'GET',
      url: `/api/duplicates/groups/${id}`,
      headers: h.headers,
    })
    expect(detail.statusCode).toBe(200)
    const group = detail.json() as DuplicateGroupDTO
    expect(group.id).toBe(id)
    expect(group.members).toHaveLength(2)
    expect(group.members[0]!.libraryName).toBe('Lib')
    expect(group.members[0]!.rootPath).toBe('Lib')
    expect(group.members[0]!.thumbnailUrl).toStartWith('/api/assets/')
    expect(group.members[0]!.sameInode).toBe(false)

    const missing = await h.app.inject({
      method: 'GET',
      url: '/api/duplicates/groups/dup_0000000000000000',
      headers: h.headers,
    })
    expect(missing.statusCode).toBe(404)
    h.db.close()
  })

  test('a reviewer can keep or ignore a group, but never delete one', async () => {
    const h = await createHarness()
    seedGroups(h.db)
    const id = h.db.query<{ id: string }, []>('SELECT id FROM duplicate_groups LIMIT 1').get()!.id

    const keep = await h.app.inject({
      method: 'POST',
      url: `/api/duplicates/groups/${id}/decisions`,
      headers: h.headers,
      payload: { action: 'keep' },
    })
    expect(keep.statusCode).toBe(200)
    expect(keep.json()).toEqual({ id, state: 'kept' })

    const ignore = await h.app.inject({
      method: 'POST',
      url: `/api/duplicates/groups/${id}/decisions`,
      headers: h.headers,
      payload: { action: 'ignore' },
    })
    expect(ignore.json()).toEqual({ id, state: 'ignored' })

    const remove = await h.app.inject({
      method: 'POST',
      url: `/api/duplicates/groups/${id}/decisions`,
      headers: h.headers,
      payload: { action: 'delete' },
    })
    expect(remove.statusCode).toBe(409)
    expect(remove.json()).toEqual({
      error: 'delete_not_available',
      message: '중복 삭제는 파일 작업 엔진이 켜진 뒤 별도 확인을 거칩니다.',
    })

    const unknown = await h.app.inject({
      method: 'POST',
      url: `/api/duplicates/groups/${id}/decisions`,
      headers: h.headers,
      payload: { action: 'purge' },
    })
    expect(unknown.statusCode).toBe(400)

    const missing = await h.app.inject({
      method: 'POST',
      url: '/api/duplicates/groups/dup_0000000000000000/decisions',
      headers: h.headers,
      payload: { action: 'keep' },
    })
    expect(missing.statusCode).toBe(404)

    const count = (table: string) =>
      h.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n
    expect(count('file_mutations')).toBe(0)
    expect(count('mutation_events')).toBe(0)
    expect(
      h.db
        .query<{ n: number }, []>(
          'SELECT COUNT(*) AS n FROM assets WHERE pending_delete_mutation_id IS NOT NULL',
        )
        .get()!.n,
    ).toBe(0)
    h.db.close()
  })

  test('every duplicate route needs a session', async () => {
    const h = await createHarness()
    for (const [method, url] of [
      ['POST', '/api/duplicates/scans'],
      ['GET', '/api/duplicates/groups'],
      ['GET', '/api/duplicates/groups/dup_0000000000000000'],
      ['POST', '/api/duplicates/groups/dup_0000000000000000/decisions'],
    ] as const) {
      const response = await h.app.inject({ method, url, payload: {} })
      expect(response.statusCode).toBe(401)
    }
    h.db.close()
  })
})
