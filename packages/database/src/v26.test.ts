import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  activateSearchIndexBuild,
  completeAsrJob,
  configureSearchFts,
  createAsrJob,
  createLibrary,
  deleteSearchIndexBuilds,
  failSearchIndexBuild,
  finishSearchIndexBuild,
  getActiveSearchIndexBuild,
  getSearchIndexBuild,
  insertAsset,
  listSearchIndexGcCandidates,
  listSearchIndexBuilds,
  openDatabase,
  rebuildSearchIndex,
  searchAssetNames,
  searchDialogue,
  searchFtsIntact,
  searchFtsReady,
  startSearchIndexBuild,
  upsertFolder,
} from './index'
import type { Db } from './db'
import type { NewAsset } from './assets'
import { MIGRATIONS, SCHEMA_VERSION } from './schema'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const COUNTS = { assets: 2, segments: 2, assetWatermark: 2, segmentWatermark: 2 }
const DAY = 24 * 60 * 60_000

function seed(db: Database): void {
  createLibrary(db, { id: 'lib1', name: 'Media', rootPath: 'Media', createdAt: 1 })
  const folderId = upsertFolder(db, {
    id: 'folder1',
    libraryId: 'lib1',
    parentId: null,
    relativePath: '',
    name: 'Media',
    depth: 0,
    scanId: 'seed',
  })
  insertAsset(db, {
    id: 'asset1',
    libraryId: 'lib1',
    folderId,
    relativePath: 'clip.mp4',
    filename: 'clip.mp4',
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 10,
    mtimeMs: 1,
    width: null,
    height: null,
    durationMs: null,
    takenAt: 1,
    videoCodec: null,
    audioCodec: null,
    container: 'mp4',
    indexedAt: 1,
    scanId: 'seed',
  })
}

/** A build that reached 'ready' without any index work, for trigger tests. */
function readyBuild(
  db: Database,
  options: { kind?: 'fts' | 'faiss'; source?: 'bootstrap' | 'operator' | 'boot-repair'; now?: number } = {},
): string {
  const kind = options.kind ?? 'fts'
  const build = startSearchIndexBuild(db, {
    kind,
    source: options.source ?? 'bootstrap',
    identity:
      kind === 'faiss'
        ? { modelSha256: 'sha', pipelineVersion: 'pipeline', dimensions: 8 }
        : undefined,
    now: options.now ?? 1_000,
  })
  finishSearchIndexBuild(db, build.id, COUNTS, options.now ?? 1_000)
  return build.id
}

function triggers(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'si_%' ORDER BY name`,
    )
    .all()
    .map((row) => row.name)
}

describe('schema v26 search index builds', () => {
  test('a fresh database has both tables and the four triggers', () => {
    const db = openDatabase(':memory:')

    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(26)
    expect(
      db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version,
    ).toBe(SCHEMA_VERSION)

    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name IN ('search_index_builds','search_index_active') ORDER BY name`,
      )
      .all()
      .map((row) => row.name)
    expect(tables).toEqual(['search_index_active', 'search_index_builds'])

    expect(triggers(db)).toEqual([
      'si_active_pinned',
      'si_active_ready_ins',
      'si_active_ready_upd',
      'si_kind_immutable',
    ])
  })

  test('replaying from v25 keeps the library rows and adds the build catalog', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mv-v26-'))
    dirs.push(dir)
    const file = path.join(dir, 'legacy.db')

    const legacy = new Database(file)
    legacy.exec('PRAGMA foreign_keys = ON')
    for (let index = 0; index < 25; index += 1) {
      MIGRATIONS[index]!((sql) => legacy.exec(sql))
    }
    legacy.exec('PRAGMA user_version = 25')
    seed(legacy)
    legacy.close()

    const db = openDatabase(file)

    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(
      SCHEMA_VERSION,
    )
    expect(triggers(db)).toHaveLength(4)
    expect(
      db
        .query<{ n: number }, []>('SELECT count(*) AS n FROM assets WHERE deleted_at IS NULL')
        .get()?.n,
    ).toBe(1)
    expect(
      db.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check,
    ).toBe('ok')
    expect(db.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all()).toEqual([])

    const build = startSearchIndexBuild(db, { kind: 'fts', source: 'bootstrap', now: 5 })
    expect(getSearchIndexBuild(db, build.id)?.state).toBe('building')
    db.close()
  })
})

describe('one active build per kind', () => {
  test('two sequential publishes leave exactly one pointer row and one superseded build', () => {
    const db = openDatabase(':memory:')
    const first = readyBuild(db, { now: 1_000 })
    activateSearchIndexBuild(db, first, 1_100)

    const second = readyBuild(db, { now: 2_000 })
    activateSearchIndexBuild(db, second, 2_100)

    const pointers = db
      .query<{ kind: string; buildId: string }, []>(
        'SELECT kind, build_id AS buildId FROM search_index_active',
      )
      .all()
    expect(pointers).toEqual([{ kind: 'fts', buildId: second }])

    expect(getActiveSearchIndexBuild(db, 'fts')?.id).toBe(second)
    expect(getSearchIndexBuild(db, first)?.state).toBe('superseded')
    expect(getSearchIndexBuild(db, first)?.supersededAt).toBe(2_100)
    expect(getSearchIndexBuild(db, second)?.state).toBe('ready')

    const ready = db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM search_index_builds WHERE state = 'ready'")
      .get()?.n
    expect(ready).toBe(1)
  })

  test('activating the same build twice is idempotent', () => {
    const db = openDatabase(':memory:')
    const build = readyBuild(db)

    activateSearchIndexBuild(db, build, 1_100)
    activateSearchIndexBuild(db, build, 1_200)

    expect(getSearchIndexBuild(db, build)?.state).toBe('ready')
    expect(getSearchIndexBuild(db, build)?.supersededAt).toBeNull()
  })
})

describe('the triggers hold the invariant from any call site', () => {
  test('a building row cannot become the active build', () => {
    const db = openDatabase(':memory:')
    const building = startSearchIndexBuild(db, { kind: 'fts', source: 'operator', now: 1_000 })

    expect(() => activateSearchIndexBuild(db, building.id, 1_100)).toThrow(
      /active build is not ready/,
    )
    expect(getActiveSearchIndexBuild(db, 'fts')).toBeNull()
  })

  test('a failed row cannot become the active build', () => {
    const db = openDatabase(':memory:')
    const build = startSearchIndexBuild(db, { kind: 'fts', source: 'operator', now: 1_000 })
    failSearchIndexBuild(db, build.id, 'boom', 1_100)

    expect(() => activateSearchIndexBuild(db, build.id, 1_200)).toThrow(
      /active build is not ready/,
    )
  })

  test('a pointer cannot cross kinds', () => {
    const db = openDatabase(':memory:')
    const faiss = readyBuild(db, { kind: 'faiss' })

    expect(() =>
      db
        .query('INSERT INTO search_index_active (kind, build_id, activated_at) VALUES (?, ?, ?)')
        .run('fts', faiss, 1_100),
    ).toThrow(/active build is not ready/)
  })

  test('the active build cannot leave ready', () => {
    const db = openDatabase(':memory:')
    const build = readyBuild(db)
    activateSearchIndexBuild(db, build, 1_100)

    expect(() =>
      db.query("UPDATE search_index_builds SET state = 'superseded' WHERE id = ?").run(build),
    ).toThrow(/the active build cannot leave ready/)
    expect(() =>
      db.query("UPDATE search_index_builds SET state = 'failed' WHERE id = ?").run(build),
    ).toThrow(/the active build cannot leave ready/)
    expect(getSearchIndexBuild(db, build)?.state).toBe('ready')
  })

  test('a build kind is immutable', () => {
    const db = openDatabase(':memory:')
    const build = readyBuild(db)

    expect(() =>
      db.query("UPDATE search_index_builds SET kind = 'faiss' WHERE id = ?").run(build),
    ).toThrow(/a build kind is immutable/)
  })

  test('the active build cannot be deleted', () => {
    const db = openDatabase(':memory:')
    const build = readyBuild(db)
    activateSearchIndexBuild(db, build, 1_100)

    expect(() => db.query('DELETE FROM search_index_builds WHERE id = ?').run(build)).toThrow(
      /FOREIGN KEY constraint failed/,
    )
    expect(getSearchIndexBuild(db, build)?.state).toBe('ready')
  })

  test('a dangling pointer is refused rather than passing on NULL', () => {
    const db = openDatabase(':memory:')

    expect(() =>
      db
        .query('INSERT INTO search_index_active (kind, build_id, activated_at) VALUES (?, ?, ?)')
        .run('fts', 'missing', 1_100),
    ).toThrow(/active build is not ready/)
  })
})

describe('garbage collection', () => {
  test('only old superseded and failed rows are candidates', () => {
    const db = openDatabase(':memory:')
    const now = 40 * DAY

    const oldSuperseded = readyBuild(db, { now: 1_000 })
    activateSearchIndexBuild(db, oldSuperseded, 1_100)

    const recentSuperseded = readyBuild(db, { now: now - DAY })
    activateSearchIndexBuild(db, recentSuperseded, now - DAY + 100)

    const active = readyBuild(db, { now: now - DAY + 200 })
    activateSearchIndexBuild(db, active, now - DAY + 300)

    const failed = startSearchIndexBuild(db, { kind: 'fts', source: 'operator', now: 2_000 })
    failSearchIndexBuild(db, failed.id, 'boom', 2_000)

    const building = startSearchIndexBuild(db, { kind: 'fts', source: 'operator', now: 1_000 })

    const candidates = listSearchIndexGcCandidates(db, now, 30 * DAY).map((row) => row.id)
    expect(candidates).toEqual([failed.id, oldSuperseded])
    expect(candidates).not.toContain(recentSuperseded)
    expect(candidates).not.toContain(active)
    expect(candidates).not.toContain(building.id)

    expect(deleteSearchIndexBuilds(db, now, 30 * DAY)).toBe(2)
    expect(getSearchIndexBuild(db, failed.id)).toBeNull()
    expect(getSearchIndexBuild(db, oldSuperseded)).toBeNull()

    // Past the window, the recent superseded row goes too; active and building stay.
    const later = now + 40 * DAY
    expect(listSearchIndexGcCandidates(db, later, 30 * DAY).map((row) => row.id)).toEqual([
      recentSuperseded,
    ])
    expect(deleteSearchIndexBuilds(db, later, 30 * DAY)).toBe(1)
    expect(getSearchIndexBuild(db, active)?.state).toBe('ready')
    expect(getSearchIndexBuild(db, building.id)?.state).toBe('building')
  })

  test('a build that never finished is not deleted while it is still building', () => {
    const db = openDatabase(':memory:')
    const building = startSearchIndexBuild(db, { kind: 'fts', source: 'operator', now: 1_000 })

    expect(deleteSearchIndexBuilds(db, 400 * DAY, 30 * DAY)).toBe(0)
    expect(getSearchIndexBuild(db, building.id)?.state).toBe('building')
  })
})

describe('the build list', () => {
  test('is newest first and limited', () => {
    const db = openDatabase(':memory:')
    readyBuild(db, { now: 1_000 })
    readyBuild(db, { now: 2_000 })
    readyBuild(db, { now: 3_000 })

    const all = listSearchIndexBuilds(db, 'fts', 10)
    expect(all.map((row) => row.startedAt)).toEqual([3_000, 2_000, 1_000])
    expect(listSearchIndexBuilds(db, 'fts', 2)).toHaveLength(2)
    expect(listSearchIndexBuilds(db, 'faiss', 10)).toEqual([])
  })
})

const FILENAMES = ['학교 축제.mp4', 'coast-drive.mp4']

function assetInput(id: string, folderId: string, filename: string): NewAsset {
  return {
    id,
    libraryId: 'lib1',
    folderId,
    relativePath: `Videos/${filename}`,
    filename,
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 1_000,
    mtimeMs: 1_000,
    width: 1_080,
    height: 1_920,
    durationMs: 30_000,
    takenAt: 10_000,
    videoCodec: 'h264',
    audioCodec: 'aac',
    container: 'mov,mp4',
    indexedAt: 20_000,
    scanId: 'scan1',
  }
}

/** Assets and transcripts, so a rebuild has real work and search has real rows. */
function seedSearch(): Db {
  const db = openDatabase(':memory:')
  createLibrary(db, { id: 'lib1', name: 'Videos', rootPath: 'Videos', createdAt: 1 })
  const folderId = upsertFolder(db, {
    id: 'folder1',
    libraryId: 'lib1',
    parentId: null,
    relativePath: 'Videos',
    name: 'Videos',
    depth: 0,
    scanId: 'scan1',
  })
  FILENAMES.forEach((filename, index) => {
    const assetId = `asset${index}`
    insertAsset(db, assetInput(assetId, folderId, filename))
    createAsrJob(
      db,
      {
        id: `asr${index}`,
        assetId,
        fileVersion: 1,
        modelRevision: 'asr-rev',
        alignerRevision: 'align-rev',
        pipelineVersion: 'asr-pipeline',
      },
      2_000 + index,
    )
    completeAsrJob(
      db,
      {
        jobId: `asr${index}`,
        transcriptId: `tr${index}`,
        resultDir: `${assetId}/1/asr${index}`,
        plainText: filename,
        language: 'ko',
        segments: [{ seq: 0, startMs: 1_000, endMs: 3_000, text: filename }],
      },
      2_100 + index,
    )
  })
  return db
}

describe('a rebuild that fails leaves the previous build serving', () => {
  test('a read-only database refuses the rebuild and changes nothing', () => {
    const db = seedSearch()
    // A fresh virtual table over a seeded content table fails its first
    // verification, so this boot rebuilds before it serves.
    const boot = configureSearchFts(db, true)
    expect(boot.mode).toBe('repaired')
    const before = {
      dialogue: searchDialogue(db, '학교 축제', 10),
      names: searchAssetNames(db, '학교 축제', 10),
    }

    db.exec('PRAGMA query_only = 1')
    expect(() => rebuildSearchIndex(db)).toThrow(/readonly database/)
    db.exec('PRAGMA query_only = 0')

    expect(getActiveSearchIndexBuild(db, 'fts')?.id).toBe(boot.buildId!)
    expect(getSearchIndexBuild(db, boot.buildId!)?.state).toBe('ready')
    expect(searchDialogue(db, '학교 축제', 10)).toEqual(before.dialogue)
    expect(searchAssetNames(db, '학교 축제', 10)).toEqual(before.names)
    expect(searchDialogue(db, '학교 축제', 10)).toHaveLength(1)
  })

  test('a failure after the rebuild rolls the index and the pointer back', () => {
    const db = seedSearch()
    const boot = configureSearchFts(db, true)
    const before = {
      dialogue: searchDialogue(db, '학교 축제', 10),
      names: searchAssetNames(db, '학교 축제', 10),
      counts: getSearchIndexBuild(db, boot.buildId!)!.counts,
    }

    // Aborts the last statement of the rebuild transaction, after the rebuild
    // and its verification have already run inside it.
    db.exec(`CREATE TRIGGER test_block_activate BEFORE INSERT ON search_index_active
             BEGIN SELECT RAISE(ABORT, 'activate blocked'); END`)

    expect(() => rebuildSearchIndex(db)).toThrow(/activate blocked/)
    db.exec('DROP TRIGGER test_block_activate')

    const active = getActiveSearchIndexBuild(db, 'fts')
    expect(active?.id).toBe(boot.buildId!)
    expect(active?.state).toBe('ready')
    expect(
      db.query<{ n: number }, []>("SELECT count(*) AS n FROM search_index_builds WHERE state = 'ready'")
        .get()?.n,
    ).toBe(1)

    // The building row was committed before the transaction, so it survived the
    // rollback and now carries the failure.
    const failed = listSearchIndexBuilds(db, 'fts', 10).filter((row) => row.state === 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.lastError).toContain('activate blocked')
    expect(failed[0]!.finishedAt).not.toBeNull()

    expect(searchDialogue(db, '학교 축제', 10)).toEqual(before.dialogue)
    expect(searchAssetNames(db, '학교 축제', 10)).toEqual(before.names)
    expect(searchFtsIntact(db)).toBe(true)
    expect(searchFtsReady(db)).toBe(true)
    expect(getActiveSearchIndexBuild(db, 'fts')?.counts).toEqual(before.counts)
  })
})

describe('a bootstrap that cannot move the pointer', () => {
  test('leaves no ready row behind, and the next boot bootstraps', () => {
    const db = seedSearch()
    // The v26 upgrade shape: a verified index with no catalog rows yet.
    configureSearchFts(db, true)
    db.exec('DELETE FROM search_index_active; DELETE FROM search_index_builds;')

    db.exec(`CREATE TRIGGER test_block_bootstrap BEFORE INSERT ON search_index_active
             BEGIN SELECT RAISE(ABORT, 'bootstrap blocked'); END`)
    expect(() => configureSearchFts(db, true)).toThrow(/bootstrap blocked/)
    db.exec('DROP TRIGGER test_block_bootstrap')

    expect(
      db.query<{ n: number }, []>("SELECT count(*) AS n FROM search_index_builds WHERE state = 'ready'").get()?.n,
    ).toBe(0)
    expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM search_index_active').get()?.n).toBe(0)

    const second = configureSearchFts(db, true)
    expect(second.mode).toBe('bootstrapped')
    expect(getActiveSearchIndexBuild(db, 'fts')?.state).toBe('ready')
  })
})

describe('a rebuild is idempotent', () => {
  test('twice over the same content gives the same counts, watermarks and results', () => {
    const db = seedSearch()
    configureSearchFts(db, true)
    // Start from an empty catalog so the two rebuilds are the only rows.
    db.exec('DELETE FROM search_index_active')
    db.exec('DELETE FROM search_index_builds')

    const first = rebuildSearchIndex(db)
    const afterFirst = {
      dialogue: searchDialogue(db, '학교 축제', 10),
      names: searchAssetNames(db, '학교 축제', 10),
    }
    const second = rebuildSearchIndex(db)

    expect(second.counts).toEqual(first.counts)
    expect(first.counts.assets).toBe(FILENAMES.length)
    expect(first.counts.segments).toBe(FILENAMES.length)
    expect(first.counts.assetWatermark).toBeGreaterThan(0)
    expect(first.counts.segmentWatermark).toBeGreaterThan(0)

    expect(searchDialogue(db, '학교 축제', 10)).toEqual(afterFirst.dialogue)
    expect(searchAssetNames(db, '학교 축제', 10)).toEqual(afterFirst.names)

    expect(listSearchIndexBuilds(db, 'fts', 10)).toHaveLength(2)
    expect(getActiveSearchIndexBuild(db, 'fts')?.id).toBe(second.id)
    expect(getSearchIndexBuild(db, first.id)?.state).toBe('superseded')
  })
})

