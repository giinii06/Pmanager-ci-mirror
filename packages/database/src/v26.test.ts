import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  activateSearchIndexBuild,
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
  startSearchIndexBuild,
  upsertFolder,
} from './index'
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

    expect(SCHEMA_VERSION).toBe(26)
    expect(
      db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version,
    ).toBe(26)

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
