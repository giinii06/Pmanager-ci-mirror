import type { SQLQueryBindings } from 'bun:sqlite'
import type { Db } from './db'
import type { PlaybackRecord } from './types'

type Params = SQLQueryBindings[]

export function getProgress(db: Db, userId: string, assetId: string): PlaybackRecord | null {
  return (
    db
      .query<PlaybackRecord, Params>(
        `SELECT asset_id AS assetId, position_ms AS positionMs, duration_ms AS durationMs,
                updated_at AS updatedAt
         FROM playback_progress WHERE user_id = ? AND asset_id = ?`,
      )
      .get(userId, assetId) ?? null
  )
}

export function putProgress(
  db: Db,
  userId: string,
  assetId: string,
  positionMs: number,
  durationMs: number,
  now: number,
): void {
  db.query<null, Params>(
    `INSERT INTO playback_progress (user_id, asset_id, position_ms, duration_ms, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, asset_id) DO UPDATE SET
       position_ms = excluded.position_ms,
       duration_ms = excluded.duration_ms,
       updated_at = excluded.updated_at`,
  ).run(userId, assetId, positionMs, durationMs, now)
}
