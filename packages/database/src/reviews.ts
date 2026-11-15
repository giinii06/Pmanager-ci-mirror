import type { SQLQueryBindings } from 'bun:sqlite'
import type { Db } from './db'
import type { ReviewRecord } from './types'

type Params = SQLQueryBindings[]

const REVIEW_COLUMNS = `
  id, asset_id AS assetId, user_id AS userId, rating, body,
  created_at AS createdAt, updated_at AS updatedAt
`

export interface UpsertReviewInput {
  id: string
  assetId: string
  userId: string
  rating: number
  body: string
}

export function getReview(db: Db, assetId: string, userId: string): ReviewRecord | null {
  return (
    db
      .query<ReviewRecord, Params>(
        `SELECT ${REVIEW_COLUMNS} FROM asset_reviews WHERE asset_id = ? AND user_id = ?`,
      )
      .get(assetId, userId) ?? null
  )
}

/** One review per person per asset, so a second write replaces the first. */
export function upsertReview(db: Db, input: UpsertReviewInput, now: number): ReviewRecord {
  return db
    .query<ReviewRecord, Params>(
      `INSERT INTO asset_reviews (id, asset_id, user_id, rating, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (asset_id, user_id) DO UPDATE SET
         rating = excluded.rating,
         body = excluded.body,
         updated_at = excluded.updated_at
       RETURNING ${REVIEW_COLUMNS}`,
    )
    .get(input.id, input.assetId, input.userId, input.rating, input.body, now, now)!
}

export function deleteReview(db: Db, assetId: string, userId: string): boolean {
  return (
    db
      .query<null, Params>('DELETE FROM asset_reviews WHERE asset_id = ? AND user_id = ?')
      .run(assetId, userId).changes > 0
  )
}
