import type { SQLQueryBindings } from 'bun:sqlite'
import type { AssetKind } from '@mediavault/shared'
import type { Db } from './db'
import {
  countAssetMatches,
  countSegmentMatches,
  disarmSearchFts,
  ftsPhrase,
  searchFtsIntact,
  searchFtsReady,
} from './search-fts'

type Params = SQLQueryBindings[]

export interface DialogueHit {
  assetId: string
  transcriptId: string
  seq: number
  startMs: number
  endMs: number
  text: string
}

export interface AssetNameHit {
  assetId: string
  filename: string
  kind: AssetKind
  durationMs: number | null
}

/**
 * How many trigram candidates are worth joining back to the content tables, as a
 * multiple of the requested limit. Measured on 10k assets and 100k segments: the
 * filename scan costs about 0.03 ms per 10k rows, so past a few hundred
 * candidates the join loses (0.43 ms at 175). The dialogue scan pays two joins
 * and a correlated subquery per segment, about 1.4 ms per 10k rows, so it still
 * wins at a thousand candidates (2.85 ms against 14.0 ms).
 */
export const SEARCH_FANOUT = { names: 8, dialogue: 64 } as const

/**
 * `%` and `_` are wildcards in LIKE, so a user who types them would otherwise
 * match everything. The backslash escape is declared in the statement.
 */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
}

// The projection, the filter, and the order are shared text so the trigram path
// and the oracle cannot disagree about which rows they return.
const DIALOGUE_COLUMNS = `t.asset_id AS assetId, ts.transcript_id AS transcriptId, ts.seq,
              ts.start_ms AS startMs, ts.end_ms AS endMs, ts.text`
const DIALOGUE_JOINS = `JOIN transcripts t ON t.id = ts.transcript_id
       JOIN assets a ON a.id = t.asset_id`
const DIALOGUE_FILTER = `a.deleted_at IS NULL
         AND t.file_version = a.file_version
         AND t.id = (
           SELECT t2.id FROM transcripts t2
           WHERE t2.asset_id = a.id AND t2.file_version = a.file_version
           ORDER BY t2.created_at DESC LIMIT 1
         )
         AND ts.text LIKE ? ESCAPE '\\'`
const DIALOGUE_ORDER = `ORDER BY t.created_at DESC, ts.seq ASC`

const ASSET_NAME_COLUMNS = `a.id AS assetId, a.filename, a.kind, a.duration_ms AS durationMs`
const ASSET_NAME_FILTER = `a.deleted_at IS NULL AND a.filename LIKE ? ESCAPE '\\'`
const ASSET_NAME_ORDER = `ORDER BY a.taken_at DESC, a.id DESC`

/**
 * The last time the trigram path threw on this process. Process-local, like the
 * readiness set: it describes this handle's history, not the database's.
 */
let lastFailure: { at: number; message: string } | null = null

export function lastSearchFtsQueryFailure(): { at: number; message: string } | null {
  return lastFailure
}

function recordFtsQueryFailure(table: string, error: unknown): void {
  lastFailure = {
    at: Date.now(),
    message: `${table}: ${error instanceof Error ? error.message : String(error)}`,
  }
}

/**
 * A ready handle can still meet a vtab swapped out from under it, so the fast
 * path is allowed to fail. Disarming on every failure would cost LIKE search
 * until restart over one busy moment, so only a structural break disarms.
 */
function ftsFailure(table: string, error: unknown, db: Db): void {
  recordFtsQueryFailure(table, error)
  if (!searchFtsIntact(db)) disarmSearchFts(db)
}

/**
 * Substring search over the current transcript of every asset.
 *
 * The LIKE scan is the answer, not a fallback: it is the only path that can
 * match a query shorter than three code points, which is most Korean words, and
 * every trigram hit is re-checked against it before it counts. The trigram index
 * is used only when it is ready, the query is long enough to have a token, and
 * the candidate set is small enough to be cheaper than the scan.
 */
export function searchDialogue(db: Db, query: string, limit: number): DialogueHit[] {
  const phrase = ftsPhrase(query)
  const ceiling = limit * SEARCH_FANOUT.dialogue
  if (phrase !== null && searchFtsReady(db)) {
    try {
      if (countSegmentMatches(db, phrase, ceiling + 1) <= ceiling) {
        return db
          .query<DialogueHit, Params>(
            `SELECT ${DIALOGUE_COLUMNS}
             FROM segment_search f
             JOIN transcript_segments ts ON ts.rowid = f.rowid
             ${DIALOGUE_JOINS}
             WHERE segment_search MATCH ? AND ${DIALOGUE_FILTER}
             ${DIALOGUE_ORDER}
             LIMIT ?`,
          )
          .all(phrase, likePattern(query), limit)
      }
    } catch (error) {
      ftsFailure('segment_search', error, db)
    }
  }
  return db
    .query<DialogueHit, Params>(
      `SELECT ${DIALOGUE_COLUMNS}
       FROM transcript_segments ts
       ${DIALOGUE_JOINS}
       WHERE ${DIALOGUE_FILTER}
       ${DIALOGUE_ORDER}
       LIMIT ?`,
    )
    .all(likePattern(query), limit)
}

export function searchAssetNames(db: Db, query: string, limit: number): AssetNameHit[] {
  const phrase = ftsPhrase(query)
  const ceiling = limit * SEARCH_FANOUT.names
  if (phrase !== null && searchFtsReady(db)) {
    try {
      if (countAssetMatches(db, phrase, ceiling + 1) <= ceiling) {
        return db
          .query<AssetNameHit, Params>(
            `SELECT ${ASSET_NAME_COLUMNS}
             FROM asset_search f
             JOIN assets a ON a.rowid = f.rowid
             WHERE asset_search MATCH ? AND ${ASSET_NAME_FILTER}
             ${ASSET_NAME_ORDER}
             LIMIT ?`,
          )
          .all(phrase, likePattern(query), limit)
      }
    } catch (error) {
      ftsFailure('asset_search', error, db)
    }
  }
  return db
    .query<AssetNameHit, Params>(
      `SELECT ${ASSET_NAME_COLUMNS}
       FROM assets a
       WHERE ${ASSET_NAME_FILTER}
       ${ASSET_NAME_ORDER}
       LIMIT ?`,
    )
    .all(likePattern(query), limit)
}
