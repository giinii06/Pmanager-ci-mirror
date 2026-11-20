import type { Db } from './db'
import {
  activateSearchIndexBuild,
  failSearchIndexBuild,
  failStaleSearchIndexBuilds,
  finishSearchIndexBuild,
  getActiveSearchIndexBuild,
  getSearchIndexBuild,
  SEARCH_BUILD_STALE_MS,
  searchIndexCounts,
  startSearchIndexBuild,
  type SearchIndexBuildRecord,
  type SearchIndexBuildSource,
  type SearchIndexCounts,
} from './search-index'

/**
 * The two text corpora the search box reads. One definition drives the virtual
 * table, its three triggers, and the backfill, so the two indexes cannot drift
 * apart in shape.
 */
const INDEXES = [
  { table: 'asset_search', content: 'assets', column: 'filename' },
  { table: 'segment_search', content: 'transcript_segments', column: 'text' },
] as const

const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/

/** How the index this process can use came to exist. */
export type SearchFtsMode = 'adopted' | 'bootstrapped' | 'repaired' | 'off'

export interface SearchFtsStatus {
  enabled: boolean
  mode: SearchFtsMode
  reason: string | null
  /** The build row this process serves, when there is one. */
  buildId: string | null
  /** Documents in the index, not rows in the content table. */
  assets: number
  segments: number
  /** Wall time for the whole setup, including any backfill. */
  rebuiltMs: number
  /** Wall time for the consistency check that decides readiness. */
  verifyMs: number
}

const ready = new WeakSet<Db>()

/**
 * How the last reconcile of this handle left the index. Process-local and
 * per-handle, like readiness: it answers "why did this process rebuild" and is
 * not a fact about the database.
 */
const modes = new WeakMap<Db, SearchFtsMode>()

export function searchFtsMode(db: Db): SearchFtsMode | null {
  return modes.get(db) ?? null
}

/**
 * Whether this handle can use the trigram index. Only a verification that
 * passed on the same `Db` turns it on, so a caller that skipped the setup falls
 * back to the LIKE oracle instead of trusting an index of unknown completeness.
 */
export function searchFtsReady(db: Db): boolean {
  return ready.has(db)
}

export function disarmSearchFts(db: Db): void {
  ready.delete(db)
}

/** The six triggers that keep the index following the content tables. */
export function searchFtsArmed(db: Db): boolean {
  const names = INDEXES.flatMap((index) => [
    `${index.table}_ai`,
    `${index.table}_ad`,
    `${index.table}_au`,
  ])
  const found =
    db
      .query<{ n: number }, string[]>(
        `SELECT count(*) AS n FROM sqlite_master
         WHERE type = 'trigger' AND name IN (${names.map(() => '?').join(', ')})`,
      )
      .get(...names)?.n ?? 0
  return found === names.length
}

/** Both corpora are still FTS5 tables, not a plain table wearing the name. */
export function searchFtsIntact(db: Db): boolean {
  return INDEXES.every((index) => indexState(db, index.table) === 'fts')
}

/**
 * Reconcile the trigram indexes with the configured state. Called on every
 * start, enabled or not, because the two directions are not symmetric:
 *
 * - Enabled creates the virtual tables and the triggers, then adopts the build
 *   the last process verified, or publishes one. A boot never rebuilds an index
 *   that already passes, so a healthy start costs two integrity checks.
 * - Disabled drops the triggers and leaves the tables. A trigger body writes to
 *   the index, so leaving it armed on a build without the FTS5 module would fail
 *   every insert into `assets` or `transcript_segments`. The index goes stale
 *   while it is off, which the check on the next enable repairs.
 *
 * A disabled boot writes no build row: it never attempted a build, and a row
 * per boot would grow without bound on a host that runs search off.
 */
export function configureSearchFts(db: Db, enabled: boolean): SearchFtsStatus {
  const startedAt = performance.now()
  const now = Date.now()
  const off = (reason: string): SearchFtsStatus => {
    disarmSearchFts(db)
    modes.set(db, 'off')
    return {
      enabled: false,
      mode: 'off',
      reason,
      buildId: null,
      assets: 0,
      segments: 0,
      rebuiltMs: 0,
      verifyMs: 0,
    }
  }
  const done = (
    mode: SearchFtsMode,
    buildId: string,
    counts: SearchIndexCounts,
    verifyMs: number,
  ): SearchFtsStatus => {
    modes.set(db, mode)
    return {
      enabled: true,
      mode,
      reason: null,
      buildId,
      assets: counts.assets,
      segments: counts.segments,
      rebuiltMs: Math.round((performance.now() - startedAt) * 10) / 10,
      verifyMs,
    }
  }
  if (!enabled) {
    try {
      db.transaction(() => {
        for (const index of INDEXES) dropTriggers(db, index)
      })()
      return off('disabled by configuration')
    } catch (error) {
      return off(errorMessage(error))
    }
  }

  try {
    db.transaction(() => {
      for (const index of INDEXES) {
        // `CREATE VIRTUAL TABLE IF NOT EXISTS` is a silent no-op over a plain
        // table of the same name, which would leave the triggers writing into a
        // shadow table that FTS5 never reads.
        if (indexState(db, index.table) === 'foreign') {
          throw new Error(`${index.table} exists but is not an FTS5 table`)
        }
        db.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS ${index.table}
           USING fts5(${index.column}, content='${index.content}',
                      content_rowid='rowid', tokenize='trigram')`,
        )
        db.exec(
          `CREATE TRIGGER IF NOT EXISTS ${index.table}_ai AFTER INSERT ON ${index.content} BEGIN
             INSERT INTO ${index.table}(rowid, ${index.column})
             VALUES (new.rowid, new.${index.column});
           END`,
        )
        db.exec(
          `CREATE TRIGGER IF NOT EXISTS ${index.table}_ad AFTER DELETE ON ${index.content} BEGIN
             INSERT INTO ${index.table}(${index.table}, rowid, ${index.column})
             VALUES ('delete', old.rowid, old.${index.column});
           END`,
        )
        db.exec(
          `CREATE TRIGGER IF NOT EXISTS ${index.table}_au AFTER UPDATE OF ${index.column}
           ON ${index.content} BEGIN
             INSERT INTO ${index.table}(${index.table}, rowid, ${index.column})
             VALUES ('delete', old.rowid, old.${index.column});
             INSERT INTO ${index.table}(rowid, ${index.column})
             VALUES (new.rowid, new.${index.column});
           END`,
        )
      }
    })()
  } catch (error) {
    return off(errorMessage(error))
  }

  failStaleSearchIndexBuilds(db, now, SEARCH_BUILD_STALE_MS)
  const active = getActiveSearchIndexBuild(db, 'fts')

  let verifyMs = 0
  let failure: string | null = null
  for (const index of INDEXES) {
    const started = performance.now()
    const result = verifyIndex(db, index.table)
    verifyMs += performance.now() - started
    if (result !== null) {
      failure = `${index.table} failed its integrity check: ${result}`
      break
    }
  }
  verifyMs = Math.round(verifyMs * 10) / 10

  if (failure === null) {
    ready.add(db)
    if (active) return done('adopted', active.id, active.counts, verifyMs)
    const build = startSearchIndexBuild(db, { kind: 'fts', source: 'bootstrap', now })
    const counts = searchIndexCounts(db)
    // The ready stamp and the pointer move together. Split, a failure between
    // them leaves a ready row that no pointer names and no GC collects.
    db.transaction(() => {
      finishSearchIndexBuild(db, build.id, counts, now)
      activateSearchIndexBuild(db, build.id, now)
    })()
    return done('bootstrapped', build.id, counts, verifyMs)
  }

  try {
    const build = publishFtsBuild(db, 'boot-repair', now)
    ready.add(db)
    return done('repaired', build.id, build.counts, verifyMs)
  } catch (error) {
    return off(errorMessage(error))
  }
}

/**
 * Re-derive both indexes from the content tables and make the result the active
 * build. The operator's tool after a restore, when the database was written by
 * a process that had no triggers. Throws when the indexes were never created,
 * which is the answer the operator needs.
 */
export function rebuildSearchIndex(db: Db): SearchIndexBuildRecord {
  const build = publishFtsBuild(db, 'operator', Date.now())
  ready.add(db)
  return build
}

/**
 * The one path that turns a rebuild into an active build.
 *
 * The `building` row is committed before the transaction opens, so a rollback
 * still leaves the attempt behind for the failure record and the stale reaper.
 * The rebuild, its verification, the ready stamp and the pointer move share one
 * transaction: a throw restores the previous index content and the pointer
 * never moves, so the build that was serving keeps serving.
 */
function publishFtsBuild(
  db: Db,
  source: SearchIndexBuildSource,
  now: number,
): SearchIndexBuildRecord {
  const build = startSearchIndexBuild(db, { kind: 'fts', source, now })
  try {
    db.transaction(() => {
      for (const index of INDEXES) rebuild(db, index.table)
      for (const index of INDEXES) {
        const failure = verifyIndex(db, index.table)
        if (failure !== null) {
          throw new Error(`${index.table} failed its integrity check: ${failure}`)
        }
      }
      finishSearchIndexBuild(db, build.id, searchIndexCounts(db), now)
      activateSearchIndexBuild(db, build.id, now)
    })()
  } catch (error) {
    failSearchIndexBuild(db, build.id, errorMessage(error), now)
    throw error
  }
  return getSearchIndexBuild(db, build.id)!
}

/**
 * The query as an FTS5 phrase, or null when the trigram index cannot answer it
 * faithfully and the LIKE oracle must.
 *
 * A trigram token exists only for three consecutive code points, so a two
 * character Korean word has no token to look up. A control character is
 * rejected rather than stripped: stripping would search for a different
 * substring than the LIKE verification checks, and a row holding the original
 * one would go missing. Doubling the quote is the FTS5 escape inside a phrase,
 * and nothing else from the user reaches the MATCH parser unquoted.
 */
export function ftsPhrase(query: string): string | null {
  if (CONTROL_CHARACTER.test(query)) return null
  if ([...query].length < 3) return null
  return `"${query.replace(/"/g, '""')}"`
}

/**
 * How many rows match, counted no further than `cap`. The caller only compares
 * the result with a threshold, so counting past it would scan the whole posting
 * list to produce a number nobody reads.
 */
export function countAssetMatches(db: Db, phrase: string, cap: number): number {
  return (
    db
      .query<{ n: number }, [string, number]>(
        `SELECT count(*) AS n FROM (
           SELECT rowid FROM asset_search WHERE asset_search MATCH ? LIMIT ?
         )`,
      )
      .get(phrase, cap)?.n ?? 0
  )
}

export function countSegmentMatches(db: Db, phrase: string, cap: number): number {
  return (
    db
      .query<{ n: number }, [string, number]>(
        `SELECT count(*) AS n FROM (
           SELECT rowid FROM segment_search WHERE segment_search MATCH ? LIMIT ?
         )`,
      )
      .get(phrase, cap)?.n ?? 0
  )
}

type IndexState = 'absent' | 'fts' | 'foreign'

/** `absent` and `foreign` need opposite handling, so they are not one boolean. */
function indexState(db: Db, table: string): IndexState {
  const present = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table)
  if (!present) return 'absent'
  const shadow = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(`${table}_data`)
  return shadow ? 'fts' : 'foreign'
}

/**
 * The only test of whether the index holds every qualifying row.
 *
 * The `rank` argument is what makes it compare the index against the content
 * table; without it the command checks only the internal consistency of the
 * index and passes over an empty index over a full table. A mismatch raises
 * `SQLITE_CORRUPT_VTAB`, whose message is returned here.
 *
 * `count(*)` on an external-content table is no substitute: it reads the content
 * table, so it reports the same number for an empty index as a full one.
 */
function verifyIndex(db: Db, table: string): string | null {
  try {
    db.exec(`INSERT INTO ${table}(${table}, rank) VALUES ('integrity-check', 1)`)
    return null
  } catch (error) {
    return errorMessage(error)
  }
}

function dropTriggers(db: Db, index: (typeof INDEXES)[number]): void {
  db.exec(`DROP TRIGGER IF EXISTS ${index.table}_ai`)
  db.exec(`DROP TRIGGER IF EXISTS ${index.table}_ad`)
  db.exec(`DROP TRIGGER IF EXISTS ${index.table}_au`)
}

function rebuild(db: Db, table: string): void {
  db.exec(`INSERT INTO ${table}(${table}) VALUES ('rebuild')`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
