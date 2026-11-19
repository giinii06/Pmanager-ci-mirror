import type { SQLQueryBindings } from 'bun:sqlite'
import type { Db } from './db'
import type { UserSessionRecord } from './types'

type Params = SQLQueryBindings[]

const SESSION_SELECT = `
  id, user_id AS userId, user_agent AS userAgent, created_at AS createdAt,
  last_seen_at AS lastSeenAt, expires_at AS expiresAt, revoked_at AS revokedAt
`

export interface NewSessionRow {
  id: string
  userId: string
  tokenDigest: string
  userAgent: string | null
  createdAt: number
  expiresAt: number
}

export function insertSession(db: Db, row: NewSessionRow): void {
  db.query<null, Params>(
    `INSERT INTO user_sessions (
       id, user_id, token_digest, user_agent, created_at, last_seen_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.userId,
    row.tokenDigest,
    row.userAgent,
    row.createdAt,
    row.createdAt,
    row.expiresAt,
  )
}

/** A digest lookup is the only authentication check; expiry and revocation are part of it. */
export function findSessionByDigest(
  db: Db,
  tokenDigest: string,
  now: number,
): UserSessionRecord | null {
  return (
    db
      .query<UserSessionRecord, Params>(
        `SELECT ${SESSION_SELECT} FROM user_sessions
         WHERE token_digest = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(tokenDigest, now) ?? null
  )
}

/** At most one write per interval, so media requests do not commit on every read. */
export function touchSession(db: Db, id: string, now: number, minAgeMs: number): boolean {
  const result = db
    .query<null, Params>(
      `UPDATE user_sessions SET last_seen_at = ?
       WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND last_seen_at <= ?`,
    )
    .run(now, id, now, now - minAgeMs)
  return result.changes === 1
}

export function revokeSession(db: Db, id: string, now: number, userId?: string): boolean {
  const result = userId
    ? db
        .query<null, Params>(
          'UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
        )
        .run(now, id, userId)
    : db
        .query<null, Params>(
          'UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
        )
        .run(now, id)
  return result.changes === 1
}

export function revokeAllSessions(
  db: Db,
  userId: string,
  now: number,
  exceptId?: string,
): number {
  const result = exceptId
    ? db
        .query<null, Params>(
          `UPDATE user_sessions SET revoked_at = ?
           WHERE user_id = ? AND id <> ? AND revoked_at IS NULL`,
        )
        .run(now, userId, exceptId)
    : db
        .query<null, Params>(
          'UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
        )
        .run(now, userId)
  return result.changes
}

export function listSessions(db: Db, userId: string, now: number): UserSessionRecord[] {
  return db
    .query<UserSessionRecord, Params>(
      `SELECT ${SESSION_SELECT} FROM user_sessions
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY last_seen_at DESC`,
    )
    .all(userId, now)
}

/** Removes rows that can no longer authenticate anyone. */
export function deleteStaleSessions(db: Db, before: number): number {
  const result = db
    .query<null, Params>(
      'DELETE FROM user_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)',
    )
    .run(before, before)
  return result.changes
}

export type LoginOutcome = 'pending' | 'success' | 'failure'

export interface LoginAttemptInput {
  username: string
  ip: string
  createdAt: number
}

export function insertLoginAttempt(db: Db, input: LoginAttemptInput): number {
  const result = db
    .query<null, Params>(
      `INSERT INTO auth_login_attempts (username, ip, outcome, created_at)
       VALUES (?, ?, 'pending', ?)`,
    )
    .run(input.username, input.ip, input.createdAt)
  return Number(result.lastInsertRowid)
}

export function finishLoginAttempt(db: Db, id: number, outcome: LoginOutcome): void {
  db.query<null, Params>('UPDATE auth_login_attempts SET outcome = ? WHERE id = ?').run(outcome, id)
}

export function countLoginAttempts(db: Db, ip: string, since: number): number {
  return (
    db
      .query<{ n: number }, Params>(
        'SELECT COUNT(*) AS n FROM auth_login_attempts WHERE ip = ? AND created_at > ?',
      )
      .get(ip, since)?.n ?? 0
  )
}

export function countLoginFailures(db: Db, username: string, since: number): number {
  return (
    db
      .query<{ n: number }, Params>(
        `SELECT COUNT(*) AS n FROM auth_login_attempts
         WHERE username = ? AND outcome = 'failure' AND created_at > ?`,
      )
      .get(username, since)?.n ?? 0
  )
}

/** The oldest counted row decides when the window frees up. */
export function oldestLoginAttempt(db: Db, ip: string, since: number): number | null {
  return (
    db
      .query<{ oldest: number | null }, Params>(
        'SELECT MIN(created_at) AS oldest FROM auth_login_attempts WHERE ip = ? AND created_at > ?',
      )
      .get(ip, since)?.oldest ?? null
  )
}

export function oldestLoginFailure(db: Db, username: string, since: number): number | null {
  return (
    db
      .query<{ oldest: number | null }, Params>(
        `SELECT MIN(created_at) AS oldest FROM auth_login_attempts
         WHERE username = ? AND outcome = 'failure' AND created_at > ?`,
      )
      .get(username, since)?.oldest ?? null
  )
}

export function pruneLoginAttempts(db: Db, before: number): number {
  const result = db
    .query<null, Params>('DELETE FROM auth_login_attempts WHERE created_at < ?')
    .run(before)
  return result.changes
}

export interface AuthEventInput {
  kind: string
  userId?: string | null
  username?: string | null
  ip?: string | null
  detail?: string | null
  createdAt: number
}

export function recordAuthEvent(db: Db, event: AuthEventInput): void {
  db.query<null, Params>(
    `INSERT INTO auth_events (kind, user_id, username, ip, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    event.kind,
    event.userId ?? null,
    event.username ?? null,
    event.ip ?? null,
    event.detail?.slice(0, 500) ?? null,
    event.createdAt,
  )
}
