import type { SQLQueryBindings } from 'bun:sqlite'
import type { AssetKind } from '@mediavault/shared'
import type { Db } from './db'

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
 * `%` and `_` are wildcards in LIKE, so a user who types them would otherwise
 * match everything. The backslash escape is declared in the statement.
 */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
}

/**
 * Substring search over the current transcript of every asset.
 *
 * LIKE rather than FTS5: the trigram tokenizer needs three characters, so a
 * two-character Korean or Japanese word would silently match nothing, and an
 * external-content index would need triggers that a cascading delete does not
 * fire. A scan over a few hundred thousand segments is fast enough for a
 * ranked list, and it cannot go stale.
 */
export function searchDialogue(db: Db, query: string, limit: number): DialogueHit[] {
  return db
    .query<DialogueHit, Params>(
      `SELECT t.asset_id AS assetId, ts.transcript_id AS transcriptId, ts.seq,
              ts.start_ms AS startMs, ts.end_ms AS endMs, ts.text
       FROM transcript_segments ts
       JOIN transcripts t ON t.id = ts.transcript_id
       JOIN assets a ON a.id = t.asset_id
       WHERE a.deleted_at IS NULL
         AND t.file_version = a.file_version
         AND t.id = (
           SELECT t2.id FROM transcripts t2
           WHERE t2.asset_id = a.id AND t2.file_version = a.file_version
           ORDER BY t2.created_at DESC LIMIT 1
         )
         AND ts.text LIKE ? ESCAPE '\\'
       ORDER BY t.created_at DESC, ts.seq ASC
       LIMIT ?`,
    )
    .all(likePattern(query), limit)
}

export function searchAssetNames(db: Db, query: string, limit: number): AssetNameHit[] {
  return db
    .query<AssetNameHit, Params>(
      `SELECT id AS assetId, filename, kind, duration_ms AS durationMs
       FROM assets
       WHERE deleted_at IS NULL AND filename LIKE ? ESCAPE '\\'
       ORDER BY taken_at DESC, id DESC
       LIMIT ?`,
    )
    .all(likePattern(query), limit)
}
