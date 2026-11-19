import type { SQLQueryBindings } from 'bun:sqlite'
import type { Db } from './db'
import type { PlayEventType, PlaySessionRecord, PlaybackRecord } from './types'

type Params = SQLQueryBindings[]

const PROGRESS_COLUMNS = `
  asset_id AS assetId, position_ms AS positionMs, duration_ms AS durationMs,
  file_version AS fileVersion, progress_version AS progressVersion,
  last_session_id AS lastSessionId, last_seq AS lastSeq, updated_at AS updatedAt
`

const SESSION_COLUMNS = `
  id, user_id AS userId, asset_id AS assetId, file_version AS fileVersion,
  client_session_key AS clientSessionKey, started_at AS startedAt,
  ended_at AS endedAt, view_recorded_at AS viewRecordedAt, last_seq AS lastSeq
`

/** Session rows only exist to make their events idempotent; old ones are pruned. */
export const PLAY_SESSION_RETENTION_MS = 90 * 24 * 60 * 60_000
export const PLAY_EVENT_MAX_DELTA_MS = 600_000
/** A position this close to the end counts as finishing the video. */
export const PLAY_PROGRESS_END_GAP_MS = 8_000

export function getProgress(db: Db, userId: string, assetId: string): PlaybackRecord | null {
  return (
    db
      .query<PlaybackRecord, Params>(
        `SELECT ${PROGRESS_COLUMNS}
         FROM playback_progress WHERE user_id = ? AND asset_id = ?`,
      )
      .get(userId, assetId) ?? null
  )
}

/**
 * The legacy endpoint has no event identity, so it cannot be made idempotent.
 * It stays last-write-wins until a session-managed row exists; after that its
 * writes are fenced off so a stale tab cannot roll back a newer position.
 */
export function putProgress(
  db: Db,
  userId: string,
  assetId: string,
  positionMs: number,
  durationMs: number,
  now: number,
  fileVersion: number,
): boolean {
  const result = db
    .query<null, Params>(
      `INSERT INTO playback_progress (
         user_id, asset_id, position_ms, duration_ms, updated_at, file_version, progress_version
       ) VALUES (?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (user_id, asset_id) DO UPDATE SET
         position_ms = excluded.position_ms,
         duration_ms = excluded.duration_ms,
         updated_at = excluded.updated_at,
         file_version = excluded.file_version,
         progress_version = playback_progress.progress_version + 1
       WHERE playback_progress.last_session_id IS NULL`,
    )
    .run(userId, assetId, positionMs, durationMs, now, fileVersion)
  return result.changes === 1
}

export function getPlaySession(db: Db, id: string): PlaySessionRecord | null {
  return (
    db
      .query<PlaySessionRecord, Params>(`SELECT ${SESSION_COLUMNS} FROM play_sessions WHERE id = ?`)
      .get(id) ?? null
  )
}

export interface NewPlaySession {
  id: string
  userId: string
  assetId: string
  fileVersion: number
  clientSessionKey: string
  now: number
}

export type CreatePlaySessionResult =
  | { status: 'created' | 'existing'; session: PlaySessionRecord }
  | { status: 'session_key_conflict'; session: PlaySessionRecord }

/**
 * `clientSessionKey` makes session creation itself retryable: a request that
 * committed before its response was lost returns the same session instead of
 * creating an orphan that starts its own sequence.
 */
export function createPlaySession(db: Db, input: NewPlaySession): CreatePlaySessionResult {
  return db.transaction((): CreatePlaySessionResult => {
    prunePlaySessions(db, input.now - PLAY_SESSION_RETENTION_MS)

    const existing = db
      .query<PlaySessionRecord, Params>(
        `SELECT ${SESSION_COLUMNS} FROM play_sessions
         WHERE user_id = ? AND client_session_key = ?`,
      )
      .get(input.userId, input.clientSessionKey)
    if (existing) {
      if (existing.assetId !== input.assetId || existing.fileVersion !== input.fileVersion) {
        return { status: 'session_key_conflict', session: existing }
      }
      return { status: 'existing', session: existing }
    }

    db.query<null, Params>(
      `INSERT INTO play_sessions (
         id, user_id, asset_id, file_version, client_session_key, started_at, last_seq
       ) VALUES (?, ?, ?, ?, ?, ?, 0)`,
    ).run(
      input.id,
      input.userId,
      input.assetId,
      input.fileVersion,
      input.clientSessionKey,
      input.now,
    )
    return { status: 'created', session: getPlaySession(db, input.id)! }
  }).immediate()
}

export interface PlayEventInput {
  eventId: string
  sessionId: string
  userId: string
  seq: number
  type: PlayEventType
  deltaMs?: number | null
  positionMs?: number | null
  durationMs?: number | null
  clientTimestamp?: number | null
  now: number
}

export interface PlayEventApplied {
  status: 'applied' | 'duplicate'
  duplicate: boolean
  viewCount: number
  watchTimeMs: number
  progress: PlaybackRecord | null
  lastSeq: number
}

export type PlayEventFailure =
  | { status: 'not_found' }
  | { status: 'asset_gone' }
  | { status: 'invalid' }
  | { status: 'sequence_gap'; expectedSeq: number }
  | { status: 'sequence_conflict' }
  | { status: 'event_id_conflict' }
  | { status: 'file_version_changed'; fileVersion: number }

export type PlayEventResult = PlayEventApplied | PlayEventFailure

interface AssetCounterRow {
  fileVersion: number
  viewCount: number
  watchTimeMs: number
  deletedAt: number | null
}

interface StoredEventRow {
  sessionId: string
  seq: number
  type: PlayEventType
  deltaMs: number | null
  positionMs: number | null
  durationMs: number | null
  clientTimestamp: number | null
}

interface NormalizedPayload {
  deltaMs: number | null
  positionMs: number | null
  durationMs: number | null
}

function normalizeEvent(
  input: PlayEventInput,
): { ok: true; payload: NormalizedPayload } | { ok: false } {
  if (input.type === 'view') {
    return { ok: true, payload: { deltaMs: null, positionMs: null, durationMs: null } }
  }
  if (input.type === 'watch_time') {
    if (typeof input.deltaMs !== 'number' || !Number.isFinite(input.deltaMs)) return { ok: false }
    const deltaMs = Math.round(input.deltaMs)
    if (deltaMs < 1 || deltaMs > PLAY_EVENT_MAX_DELTA_MS) return { ok: false }
    return { ok: true, payload: { deltaMs, positionMs: null, durationMs: null } }
  }
  if (
    typeof input.positionMs !== 'number' ||
    !Number.isFinite(input.positionMs) ||
    typeof input.durationMs !== 'number' ||
    !Number.isFinite(input.durationMs)
  ) {
    return { ok: false }
  }
  const durationMs = Math.round(input.durationMs)
  if (durationMs < 1 || input.positionMs < 0) return { ok: false }
  const positionMs = Math.min(Math.round(input.positionMs), durationMs)
  return { ok: true, payload: { deltaMs: null, positionMs, durationMs } }
}

function sameStoredEvent(
  stored: StoredEventRow,
  input: PlayEventInput,
  payload: NormalizedPayload,
): boolean {
  return (
    stored.sessionId === input.sessionId &&
    stored.seq === input.seq &&
    stored.type === input.type &&
    stored.deltaMs === payload.deltaMs &&
    stored.positionMs === payload.positionMs &&
    stored.durationMs === payload.durationMs &&
    stored.clientTimestamp === (input.clientTimestamp ?? null)
  )
}

function counters(db: Db, assetId: string): { viewCount: number; watchTimeMs: number } {
  return db
    .query<{ viewCount: number; watchTimeMs: number }, Params>(
      'SELECT view_count AS viewCount, watch_time_ms AS watchTimeMs FROM assets WHERE id = ?',
    )
    .get(assetId)!
}

/**
 * Applies one event in a single immediate transaction: the event row, the
 * session high-water mark and the counter/progress update commit together, so a
 * retried event either finds its receipt or never happened.
 */
export function applyPlayEvent(db: Db, input: PlayEventInput): PlayEventResult {
  return db.transaction((): PlayEventResult => {
    const session = db
      .query<PlaySessionRecord, Params>(
        `SELECT ${SESSION_COLUMNS} FROM play_sessions WHERE id = ? AND user_id = ?`,
      )
      .get(input.sessionId, input.userId)
    if (!session) return { status: 'not_found' }

    const asset = db
      .query<AssetCounterRow, Params>(
        `SELECT file_version AS fileVersion, view_count AS viewCount,
                watch_time_ms AS watchTimeMs, deleted_at AS deletedAt
         FROM assets WHERE id = ?`,
      )
      .get(session.assetId)
    if (!asset) return { status: 'not_found' }
    if (asset.deletedAt !== null) return { status: 'asset_gone' }

    const normalized = normalizeEvent(input)
    if (!normalized.ok) return { status: 'invalid' }

    const stored = db
      .query<StoredEventRow, Params>(
        `SELECT session_id AS sessionId, seq, event_type AS type, delta_ms AS deltaMs,
                position_ms AS positionMs, duration_ms AS durationMs,
                client_timestamp AS clientTimestamp
         FROM play_events WHERE event_id = ?`,
      )
      .get(input.eventId)
    if (stored) {
      if (!sameStoredEvent(stored, input, normalized.payload)) return { status: 'event_id_conflict' }
      return {
        status: 'duplicate',
        duplicate: true,
        ...counters(db, session.assetId),
        progress: getProgress(db, session.userId, session.assetId),
        lastSeq: session.lastSeq,
      }
    }

    // A replay of a committed event is answered above even after the file
    // changed. A new event from the old playback attempt is not accepted: its
    // time and position belong to a file that no longer exists.
    if (session.fileVersion !== asset.fileVersion) {
      return { status: 'file_version_changed', fileVersion: asset.fileVersion }
    }

    const expectedSeq = session.lastSeq + 1
    if (input.seq > expectedSeq) return { status: 'sequence_gap', expectedSeq }
    if (input.seq < expectedSeq) return { status: 'sequence_conflict' }

    db.query<null, Params>(
      `INSERT INTO play_events (
         event_id, session_id, seq, event_type, delta_ms, position_ms, duration_ms,
         client_timestamp, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.eventId,
      session.id,
      input.seq,
      input.type,
      normalized.payload.deltaMs,
      normalized.payload.positionMs,
      normalized.payload.durationMs,
      input.clientTimestamp ?? null,
      input.now,
    )
    db.query<null, Params>('UPDATE play_sessions SET last_seq = ? WHERE id = ?').run(
      input.seq,
      session.id,
    )

    if (input.type === 'view') {
      // The session itself is the once-per-playback guard: a second view event,
      // even with a fresh event id, cannot add another count.
      const stamped = db
        .query<null, Params>(
          'UPDATE play_sessions SET view_recorded_at = ? WHERE id = ? AND view_recorded_at IS NULL',
        )
        .run(input.now, session.id)
      if (stamped.changes === 1) {
        db.query<null, Params>(
          'UPDATE assets SET view_count = view_count + 1 WHERE id = ?',
        ).run(session.assetId)
      }
    } else if (input.type === 'watch_time') {
      db.query<null, Params>(
        'UPDATE assets SET watch_time_ms = watch_time_ms + ? WHERE id = ?',
      ).run(normalized.payload.deltaMs, session.assetId)
    } else {
      db.query<null, Params>(
        `INSERT INTO playback_progress (
           user_id, asset_id, position_ms, duration_ms, updated_at, file_version,
           progress_version, last_session_id, last_seq
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (user_id, asset_id) DO UPDATE SET
           position_ms = excluded.position_ms,
           duration_ms = excluded.duration_ms,
           updated_at = excluded.updated_at,
           file_version = excluded.file_version,
           progress_version = playback_progress.progress_version + 1,
           last_session_id = excluded.last_session_id,
           last_seq = excluded.last_seq`,
      ).run(
        session.userId,
        session.assetId,
        normalized.payload.positionMs,
        normalized.payload.durationMs,
        input.now,
        session.fileVersion,
        session.id,
        input.seq,
      )
      if (
        normalized.payload.durationMs !== null &&
        normalized.payload.positionMs !== null &&
        normalized.payload.durationMs - normalized.payload.positionMs <= PLAY_PROGRESS_END_GAP_MS
      ) {
        db.query<null, Params>(
          'UPDATE play_sessions SET ended_at = COALESCE(ended_at, ?) WHERE id = ?',
        ).run(input.now, session.id)
      }
    }

    return {
      status: 'applied',
      duplicate: false,
      ...counters(db, session.assetId),
      progress: getProgress(db, session.userId, session.assetId),
      lastSeq: input.seq,
    }
  }).immediate()
}

export function prunePlaySessions(db: Db, before: number): number {
  // RETURNING counts the deleted sessions themselves; `changes` would also
  // count the events removed by the foreign key cascade.
  const rows = db
    .query<{ id: string }, Params>('DELETE FROM play_sessions WHERE started_at < ? RETURNING id')
    .all(before)
  return rows.length
}
