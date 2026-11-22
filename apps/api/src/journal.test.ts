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
} from '@mediavault/database'
import type { JournalEntryDTO, JournalMentionDTO } from '@mediavault/shared'
import { buildApp } from './app'
import { createSession, SESSION_COOKIE } from './auth'
import { loadConfig } from './config'
import { Semaphore } from './semaphore'

const SECRET = 'journal-test-auth-secret-is-long-enough'
const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

describe('authenticated journal routes', () => {
  test('creates a server-dated page, edits it, resolves mentions and enforces ownership', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mv-journal-api-'))
    dirs.push(dir)
    await mkdir(path.join(dir, 'media'), { recursive: true })
    const config = await loadConfig({
      DATA_DIR: path.join(dir, 'data'),
      CACHE_DIR: path.join(dir, 'cache'),
      MEDIA_ROOT: path.join(dir, 'media'),
      AUTH_SECRET: SECRET,
      ASR_ENABLED: '0',
      TRANSLATION_ENABLED: '0',
      EMBEDDING_ENABLED: '0',
      SCENE_ENABLED: '0',
    })
    const db = openDatabase(':memory:')
    createUser(db, { id: 'u1', username: 'owner', passwordHash: 'h', createdAt: 1 })
    createUser(db, { id: 'u2', username: 'guest', passwordHash: 'h', createdAt: 1 })
    const app = await buildApp({ config, db, thumbnails: new Semaphore(2), previews: new Semaphore(2) })
    const owner = { cookie: SESSION_COOKIE + '=' + createSession(db, 'u1', SECRET, { ttlMs: 3_600_000 }).token }
    const guest = { cookie: SESSION_COOKIE + '=' + createSession(db, 'u2', SECRET, { ttlMs: 3_600_000 }).token }

    expect((await app.inject({ method: 'GET', url: '/api/journal' })).statusCode).toBe(401)
    const before = Date.now()
    const created = await app.inject({
      method: 'POST',
      url: '/api/journal',
      headers: owner,
      payload: { createdAt: '2000-01-01T00:00:00Z' },
    })
    const after = Date.now()
    expect(created.statusCode).toBe(201)
    const page = created.json() as JournalEntryDTO
    expect(page.title).toBe('')
    expect(page.body).toBe('')
    expect(Date.parse(page.createdAt)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(page.createdAt)).toBeLessThanOrEqual(after)

    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/journal/' + page.id,
      headers: owner,
      payload: {
        title: '여행 일지',
        body: '오늘은 @[Trip movie.mp4](video:video1)와 @[Trip album](album:photos)를 봤다.',
        expectedUpdatedAt: page.updatedAt,
        createdAt: '2000-01-01T00:00:00Z',
      },
    })
    expect(updated.statusCode).toBe(400)
    const edited = await app.inject({
      method: 'PATCH',
      url: '/api/journal/' + page.id,
      headers: owner,
      payload: {
        title: '여행 일지',
        body: '오늘은 @[Trip movie.mp4](video:video1)와 @[Trip album](album:photos)를 봤다.',
        expectedUpdatedAt: page.updatedAt,
      },
    })
    expect(edited.statusCode).toBe(200)
    expect((edited.json() as JournalEntryDTO).createdAt).toBe(page.createdAt)
    const conflict = await app.inject({
      method: 'PATCH',
      url: '/api/journal/' + page.id,
      headers: owner,
      payload: { title: 'other tab overwrite', expectedUpdatedAt: page.updatedAt },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error).toBe('journal_conflict')
    expect(conflict.json().current.title).toBe('여행 일지')

    const mine = await app.inject({ method: 'GET', url: '/api/journal', headers: owner })
    expect(mine.statusCode).toBe(200)
    expect(mine.json().items.map((x: { id: string }) => x.id)).toContain(page.id)
    expect((await app.inject({ method: 'GET', url: '/api/journal', headers: guest })).json().items).toEqual([])
    expect((await app.inject({ method: 'GET', url: '/api/journal/' + page.id, headers: guest })).statusCode).toBe(404)
    expect((await app.inject({
      method: 'PATCH',
      url: '/api/journal/' + page.id,
      headers: guest,
      payload: { title: 'attack', expectedUpdatedAt: page.updatedAt },
    })).statusCode).toBe(404)
    expect((await app.inject({
      method: 'DELETE',
      url: '/api/journal/' + page.id,
      headers: guest,
    })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/journal/' + page.id, headers: owner })).json().title).toBe('여행 일지')

    // Inline images are private to their owner and cascade with their page.
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
    const upload = await app.inject({
      method: 'POST', url: '/api/journal/' + page.id + '/images',
      headers: { ...owner, 'content-type': 'image/png' }, payload: image,
    })
    expect(upload.statusCode).toBe(201)
    const imageId = (upload.json() as { id: string }).id
    const imageUrl = '/api/journal/' + page.id + '/images/' + imageId
    const ownerImage = await app.inject({ method: 'GET', url: imageUrl, headers: owner })
    expect(ownerImage.statusCode).toBe(200)
    expect(ownerImage.headers['content-type']).toContain('image/png')
    expect(ownerImage.rawPayload).toEqual(image)
    expect((await app.inject({ method: 'GET', url: imageUrl, headers: guest })).statusCode).toBe(404)
    const invalidImage = await app.inject({
      method: 'POST', url: '/api/journal/' + page.id + '/images',
      headers: { ...owner, 'content-type': 'image/png' }, payload: Buffer.from('not-an-image'),
    })
    expect(invalidImage.statusCode).toBe(415)
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM journal_images').get()?.n).toBe(1)

    createLibrary(db, { id: 'lib', name: 'My library', rootPath: 'My library', createdAt: 1 })
    upsertFolder(db, {
      id: 'photos',
      libraryId: 'lib',
      parentId: null,
      relativePath: 'Trip album',
      name: 'Trip album',
      depth: 0,
      scanId: 's',
      createdAt: 1,
    })
    for (const asset of [
      { id: 'video1', filename: 'Trip movie.mp4', kind: 'video' as const },
      { id: 'photo1', filename: 'Trip.jpg', kind: 'image' as const },
    ]) {
      insertAsset(db, {
        id: asset.id,
        libraryId: 'lib',
        folderId: 'photos',
        relativePath: asset.filename,
        filename: asset.filename,
        kind: asset.kind,
        mimeType: asset.kind === 'video' ? 'video/mp4' : 'image/jpeg',
        sizeBytes: 100,
        mtimeMs: 1,
        width: null,
        height: null,
        durationMs: null,
        takenAt: 1,
        videoCodec: null,
        audioCodec: null,
        container: null,
        indexedAt: 1,
        scanId: 's',
      })
    }
    const mentions = await app.inject({
      method: 'GET',
      url: '/api/journal/mentions?q=Trip',
      headers: owner,
    })
    expect(mentions.statusCode).toBe(200)
    expect((mentions.json().items as JournalMentionDTO[]).map((x) => x.type))
      .toEqual(['video', 'album'])
    expect((await app.inject({
      method: 'DELETE',
      url: '/api/journal/' + page.id,
      headers: owner,
    })).statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/api/journal/' + page.id, headers: owner })).statusCode).toBe(404)
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM journal_images').get()?.n).toBe(0)
    await app.close()
    db.close()
  })
})
