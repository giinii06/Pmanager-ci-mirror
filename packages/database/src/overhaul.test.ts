import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  addAssetWatchTime,
  addTagToAsset,
  bumpPosterVersion,
  createLibrary,
  createTag,
  createUser,
  deleteAssetPermanently,
  deleteTag,
  enqueueArchiveJobIfNeeded,
  enqueueJob,
  getActivityStats,
  getAsset,
  getStats,
  incrementAssetView,
  insertAsset,
  listAllFolders,
  listArchiveJobs,
  listAssets,
  listMatchingAssetIds,
  listTags,
  openDatabase,
  reconcileContributions,
  removeTagFromAsset,
  renameTag,
  updateArchiveJob,
  upsertFolder,
  voteAsset,
  voteFolder,
} from './index'
import { MIGRATIONS, SCHEMA_VERSION } from './schema'
import type { NewAsset } from './assets'

function makeVideo(
  id: string,
  opts: Partial<NewAsset> & { folderId?: string; takenAt?: number; indexedAt?: number } = {},
): NewAsset {
  return {
    id,
    libraryId: opts.libraryId ?? 'lib1',
    folderId: opts.folderId ?? 'vf1',
    relativePath: opts.relativePath ?? `Videos/${id}.mp4`,
    filename: opts.filename ?? `${id}.mp4`,
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: opts.sizeBytes ?? 10_000,
    mtimeMs: opts.mtimeMs ?? 10_000,
    width: 1920,
    height: 1080,
    durationMs: 60_000,
    takenAt: opts.takenAt ?? 1_000,
    videoCodec: 'h264',
    audioCodec: 'aac',
    container: 'mov,mp4',
    indexedAt: opts.indexedAt ?? Date.now(),
    scanId: 'scan1',
  }
}

function makeImage(
  id: string,
  folderId: string,
  relativePath: string,
  indexedAt = Date.now(),
): NewAsset {
  return {
    id,
    libraryId: 'lib1',
    folderId,
    relativePath,
    filename: relativePath.split('/').pop() ?? `${id}.jpg`,
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 5_000,
    mtimeMs: indexedAt,
    width: 1200,
    height: 1600,
    durationMs: null,
    takenAt: indexedAt,
    videoCodec: null,
    audioCodec: null,
    container: null,
    indexedAt,
    scanId: 'scan1',
  }
}

function setupVideoDb() {
  const db = openDatabase(':memory:')
  createLibrary(db, { id: 'lib1', name: 'Media', rootPath: '/media', createdAt: 1 })
  upsertFolder(db, {
    id: 'vf1',
    libraryId: 'lib1',
    parentId: null,
    relativePath: 'Videos',
    name: 'Videos',
    depth: 0,
    scanId: 'scan1',
    createdAt: 100,
  })
  return db
}

describe('migration v12 to v13', () => {
  test('migrates favorites counts to vote_count and removes favorites and face tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-mig13-'))
    const file = join(dir, 'db.sqlite')
    try {
      const old = new Database(file, { create: true })
      old.exec('PRAGMA foreign_keys = ON')
      for (let i = 0; i < 12; i += 1) {
        MIGRATIONS[i]!((sql) => old.exec(sql))
      }
      old.exec('PRAGMA user_version = 12')
      createUser(old, { id: 'u1', username: 'u1', passwordHash: 'x', createdAt: 1 })
      createUser(old, { id: 'u2', username: 'u2', passwordHash: 'x', createdAt: 1 })
      createLibrary(old, { id: 'lib1', name: 'Lib', rootPath: '/lib', createdAt: 1 })
      old
        .query(
          "INSERT INTO folders (id, library_id, parent_id, relative_path, name, depth, last_seen_scan) VALUES ('f1', 'lib1', NULL, 'Videos', 'Videos', 0, 's1')",
        )
        .run()
      old
        .query(
          `INSERT INTO assets (id, library_id, folder_id, relative_path, filename, kind, mime_type, size_bytes, mtime_ms, taken_at, indexed_at)
           VALUES ('a1', 'lib1', 'f1', 'Videos/a1.mp4', 'a1.mp4', 'video', 'video/mp4', 100, 100, 100, 100)`,
        )
        .run()
      old.query("INSERT INTO favorites (user_id, asset_id, created_at) VALUES ('u1', 'a1', 10)").run()
      old.query("INSERT INTO favorites (user_id, asset_id, created_at) VALUES ('u2', 'a1', 20)").run()
      old.close()

      const db = openDatabase(file)
      const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()
      expect(version?.user_version).toBe(SCHEMA_VERSION)
      expect(getAsset(db, 'a1')?.voteCount).toBe(2)

      const tables = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name)
      expect(tables).not.toContain('favorites')
      expect(tables).not.toContain('face_jobs')
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('views, watch time, rate, and sorting', () => {
  test('persists views, watch time, and votes across database reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-persist-'))
    const file = join(dir, 'db.sqlite')
    try {
      const db1 = openDatabase(file)
      createLibrary(db1, { id: 'lib1', name: 'Media', rootPath: '/media', createdAt: 1 })
      upsertFolder(db1, {
        id: 'vf1',
        libraryId: 'lib1',
        parentId: null,
        relativePath: 'Videos',
        name: 'Videos',
        depth: 0,
        scanId: 'scan1',
      })
      insertAsset(db1, makeVideo('v1'))
      incrementAssetView(db1, 'v1')
      addAssetWatchTime(db1, 'v1', 42_500)
      voteAsset(db1, 'v1')
      voteAsset(db1, 'v1')
      bumpPosterVersion(db1, 'v1')
      db1.close()

      const db2 = openDatabase(file)
      const loaded = getAsset(db2, 'v1')
      expect(loaded).toMatchObject({
        viewCount: 1,
        watchTimeMs: 42_500,
        voteCount: 2,
        posterVersion: 2,
        rate: 50,
      })
      db2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('computes relative Rate percentiles, null for missing data, and sorts unrated last by seed', () => {
    const db = setupVideoDb()
    for (const id of ['v1', 'v2', 'v3', 'v4', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6']) {
      insertAsset(db, makeVideo(id, { filename: `${id}.mp4` }))
    }
    incrementAssetView(db, 'v1')
    addAssetWatchTime(db, 'v1', 1_000)

    incrementAssetView(db, 'v2')
    addAssetWatchTime(db, 'v2', 1_000)

    incrementAssetView(db, 'v3')
    addAssetWatchTime(db, 'v3', 5_000)

    incrementAssetView(db, 'v4')

    expect(getAsset(db, 'v1')?.rate).toBe(33.3)
    expect(getAsset(db, 'v2')?.rate).toBe(33.3)
    expect(getAsset(db, 'v3')?.rate).toBe(83.3)
    expect(getAsset(db, 'v4')?.rate).toBeNull()
    expect(getAsset(db, 'u1')?.rate).toBeNull()

    const pageA = listAssets(db, { kind: 'video', sort: 'rate', seed: 101 }, null, 20)
    expect(pageA.records[0]?.id).toBe('v3')
    expect(['v1', 'v2']).toContain(pageA.records[1]!.id)
    expect(['v1', 'v2']).toContain(pageA.records[2]!.id)
    const unratedOrderSeed1 = pageA.records.slice(3).map((r) => r.id)
    expect(unratedOrderSeed1).toHaveLength(7)

    const pageARepeat = listAssets(db, { kind: 'video', sort: 'rate', seed: 101 }, null, 20)
    expect(pageARepeat.records.slice(3).map((r) => r.id)).toEqual(unratedOrderSeed1)

    const pageB = listAssets(db, { kind: 'video', sort: 'rate', seed: 98765 }, null, 20)
    expect(pageB.records[0]?.id).toBe('v3')
    expect(pageB.records.slice(3).map((r) => r.id)).not.toEqual(unratedOrderSeed1)
    db.close()
  })

  test('supports all 6 sort modes and full matching id list', () => {
    const db = setupVideoDb()
    insertAsset(db, makeVideo('a', { filename: 'zeta.mp4', takenAt: 100 }))
    insertAsset(db, makeVideo('b', { filename: 'alpha.mp4', takenAt: 300 }))
    insertAsset(db, makeVideo('c', { filename: 'mid.mp4', takenAt: 200 }))

    incrementAssetView(db, 'a')
    incrementAssetView(db, 'a')
    incrementAssetView(db, 'a')
    addAssetWatchTime(db, 'a', 3_000)

    incrementAssetView(db, 'b')
    addAssetWatchTime(db, 'b', 4_000)

    incrementAssetView(db, 'c')
    incrementAssetView(db, 'c')
    addAssetWatchTime(db, 'c', 1_000)
    voteAsset(db, 'c')
    voteAsset(db, 'c')
    voteAsset(db, 'a')

    expect(listMatchingAssetIds(db, { kind: 'video', sort: 'rate' })).toEqual(['b', 'a', 'c'])
    expect(listMatchingAssetIds(db, { kind: 'video', sort: 'views' })).toEqual(['a', 'c', 'b'])
    expect(listMatchingAssetIds(db, { kind: 'video', sort: 'watch_time' })).toEqual(['b', 'a', 'c'])
    expect(listMatchingAssetIds(db, { kind: 'video', sort: 'latest' })).toEqual(['b', 'c', 'a'])
    expect(listMatchingAssetIds(db, { kind: 'video', sort: 'name' })).toEqual(['b', 'c', 'a'])
    expect(listMatchingAssetIds(db, { kind: 'video', sort: 'votes' })).toEqual(['c', 'a', 'b'])
    db.close()
  })
})

describe('tags, folders, contributions, permanent deletion, archives', () => {
  test('manages tags, filters by tag, and cascades deletions', () => {
    const db = setupVideoDb()
    insertAsset(db, makeVideo('v1'))
    insertAsset(db, makeVideo('v2'))

    const t1 = createTag(db, 't1', 'Dance', 10)
    const t2 = createTag(db, 't2', 'Live', 20)
    addTagToAsset(db, 'v1', t1.id, 30)
    addTagToAsset(db, 'v1', t2.id, 31)
    addTagToAsset(db, 'v2', t1.id, 32)

    expect(getAsset(db, 'v1')?.tags.map((t) => t.name)).toEqual(['Dance', 'Live'])
    expect(listAssets(db, { kind: 'video', tagId: t2.id }, null, 10).records.map((r) => r.id)).toEqual([
      'v1',
    ])

    renameTag(db, t1.id, 'Solo')
    expect(listTags(db).map((t) => ({ name: t.name, assetCount: t.assetCount }))).toEqual([
      { name: 'Live', assetCount: 1 },
      { name: 'Solo', assetCount: 2 },
    ])

    removeTagFromAsset(db, 'v1', t2.id)
    expect(listTags(db).find((t) => t.id === t2.id)?.assetCount).toBe(0)

    deleteTag(db, t1.id)
    expect(getAsset(db, 'v2')?.tags).toEqual([])
    expect(getStats(db).tags).toBe(1)
    db.close()
  })

  test('computes folder view sums, cumulative folder votes, and 4 folder sorts', () => {
    const db = openDatabase(':memory:')
    createLibrary(db, { id: 'lib1', name: 'Photos', rootPath: '/photos', createdAt: 1 })
    upsertFolder(db, {
      id: 'f1',
      libraryId: 'lib1',
      parentId: null,
      relativePath: 'Beta',
      name: 'Beta',
      depth: 0,
      scanId: 's1',
      createdAt: 1_000,
    })
    upsertFolder(db, {
      id: 'f2',
      libraryId: 'lib1',
      parentId: null,
      relativePath: 'Alpha',
      name: 'Alpha',
      depth: 0,
      scanId: 's1',
      createdAt: 3_000,
    })
    insertAsset(db, makeImage('p1', 'f1', 'Beta/1.jpg', 1_000))
    insertAsset(db, makeImage('p2', 'f1', 'Beta/2.jpg', 1_100))
    insertAsset(db, makeImage('p3', 'f2', 'Alpha/1.jpg', 3_000))

    incrementAssetView(db, 'p1')
    incrementAssetView(db, 'p1')
    incrementAssetView(db, 'p2')
    voteFolder(db, 'f2')

    expect(listAllFolders(db, 'views').map((f) => [f.id, f.viewCount])).toEqual([
      ['f1', 3],
      ['f2', 0],
    ])
    expect(listAllFolders(db, 'votes').map((f) => [f.id, f.voteCount])).toEqual([
      ['f2', 1],
      ['f1', 0],
    ])
    expect(listAllFolders(db, 'name').map((f) => f.id)).toEqual(['f2', 'f1'])
    expect(listAllFolders(db, 'date').map((f) => f.id)).toEqual(['f2', 'f1'])
    db.close()
  })

  test('reconcileContributions counts 1 per photo folder and 1 per standalone video idempotently', () => {
    const db = openDatabase(':memory:')
    createLibrary(db, { id: 'lib1', name: 'Media', rootPath: '/media', createdAt: 1 })
    upsertFolder(db, {
      id: 'pf1',
      libraryId: 'lib1',
      parentId: null,
      relativePath: 'SetA',
      name: 'SetA',
      depth: 0,
      scanId: 's1',
      createdAt: 100,
    })
    upsertFolder(db, {
      id: 'vf1',
      libraryId: 'lib1',
      parentId: null,
      relativePath: 'Clips',
      name: 'Clips',
      depth: 0,
      scanId: 's1',
      createdAt: 100,
    })

    const today = Date.now()
    insertAsset(db, makeImage('i1', 'pf1', 'SetA/01.jpg', today))
    insertAsset(db, makeImage('i2', 'pf1', 'SetA/02.jpg', today))
    insertAsset(
      db,
      makeVideo('v_inside', {
        folderId: 'pf1',
        relativePath: 'SetA/bonus.mp4',
        filename: 'bonus.mp4',
        indexedAt: today,
      }),
    )
    insertAsset(
      db,
      makeVideo('v_solo', {
        folderId: 'vf1',
        relativePath: 'Clips/movie.avi',
        filename: 'movie.avi',
        indexedAt: today,
      }),
    )

    expect(reconcileContributions(db)).toBe(2)
    expect(reconcileContributions(db)).toBe(0)

    db.query("UPDATE assets SET relative_path = 'Clips/movie.mp4', filename = 'movie.mp4' WHERE id = 'v_solo'").run()
    expect(reconcileContributions(db)).toBe(0)

    const stats = getActivityStats(db, today)
    expect(stats.totalCount).toBe(2)
    expect(stats.folderContributions).toBe(1)
    expect(stats.videoContributions).toBe(1)
    db.close()
  })

  test('permanent deletion clears asset, jobs, and tags without leaving rows behind', () => {
    const db = setupVideoDb()
    insertAsset(db, makeVideo('v1'))
    const t = createTag(db, 't1', 'Clip', 1)
    addTagToAsset(db, 'v1', t.id, 2)
    enqueueJob(db, { dedupeKey: 'thumb:v1', kind: 'thumbnail', priority: 0, assetId: 'v1' }, 10)

    const res = deleteAssetPermanently(db, 'v1')
    expect(res.deleted).toBe(true)
    expect(res.libraryRoot).toBe('/media')
    expect(getAsset(db, 'v1')).toBeNull()
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM jobs WHERE asset_id = 'v1'").get()?.n).toBe(0)
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM asset_tags WHERE asset_id = 'v1'").get()?.n).toBe(0)
    db.close()
  })

  test('archive job deduplication skips active/completed/failed_password signatures', () => {
    const db = setupVideoDb()
    const first = enqueueArchiveJobIfNeeded(
      db,
      { id: 'aj1', libraryId: 'lib1', archivePath: 'SetA.rar', signature: '100:200:1' },
      10,
    )
    expect(first.created).toBe(true)

    updateArchiveJob(db, 'aj1', { state: 'failed_password', errorMessage: 'bad pass' }, 20)
    const repeat = enqueueArchiveJobIfNeeded(
      db,
      { id: 'aj2', libraryId: 'lib1', archivePath: 'SetA.rar', signature: '100:200:1' },
      30,
    )
    expect(repeat.created).toBe(false)
    expect(listArchiveJobs(db)).toHaveLength(1)
    db.close()
  })
})
