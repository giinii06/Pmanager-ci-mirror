import type { SQLQueryBindings } from 'bun:sqlite'
import { newId, type NotificationState } from '@mediavault/shared'
import type { Db } from './db'
import type {
  NotificationDeliveryRecord,
  NotificationFinding,
  NotificationRecord,
} from './types'

type Params = SQLQueryBindings[]

const NOTIFICATION_SELECT = `
  id, kind, severity, state, dedupe_key AS dedupeKey, title, body,
  metadata_json AS metadataJson, occurrences, read_at AS readAt,
  first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
  last_notified_at AS lastNotifiedAt, resolved_at AS resolvedAt,
  created_at AS createdAt, updated_at AS updatedAt
`

const DELIVERY_SELECT = `
  id, notification_id AS notificationId, channel, message_kind AS messageKind,
  status, attempts, next_attempt_at AS nextAttemptAt, last_error AS lastError,
  created_at AS createdAt, updated_at AS updatedAt
`

/** 1m, 5m, 15m between tries; the third failure gives up. */
export const DELIVERY_RETRY_SCHEDULE_MS = [60_000, 300_000, 900_000] as const
export const DELIVERY_MAX_ATTEMPTS = 3

export interface UpsertNotificationResult {
  notification: NotificationRecord
  created: boolean
  /** The caller creates a delivery row only when this is true. */
  deliver: boolean
}

function getActiveByKey(db: Db, dedupeKey: string): NotificationRecord | null {
  return (
    db
      .query<NotificationRecord, Params>(
        `SELECT ${NOTIFICATION_SELECT} FROM notifications
         WHERE dedupe_key = ? AND state IN ('open','dismissed')`,
      )
      .get(dedupeKey) ?? null
  )
}

export function getNotification(db: Db, id: string): NotificationRecord | null {
  return (
    db.query<NotificationRecord, Params>(`SELECT ${NOTIFICATION_SELECT} FROM notifications WHERE id = ?`)
      .get(id) ?? null
  )
}

/**
 * One incident keeps one row. A persisting condition bumps `occurrences` and
 * only notifies again after `cooldownMs`; a dismissed condition stays silent
 * until it resolves. A resolved row no longer occupies the dedupe key, so the
 * next incident of the same kind opens a fresh row.
 */
export function upsertNotification(
  db: Db,
  finding: NotificationFinding,
  now: number,
  cooldownMs: number,
): UpsertNotificationResult {
  return db.transaction(() => {
    let existing = getActiveByKey(db, finding.dedupeKey)
    if (!existing) {
      const id = newId(16)
      try {
        db.query<null, Params>(
          `INSERT INTO notifications (
             id, kind, severity, state, dedupe_key, title, body, metadata_json,
             occurrences, first_seen_at, last_seen_at, last_notified_at, created_at, updated_at
           ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          finding.kind,
          finding.severity,
          finding.dedupeKey,
          finding.title,
          finding.body,
          finding.metadata === undefined ? null : JSON.stringify(finding.metadata),
          now,
          now,
          now,
          now,
          now,
        )
        return { notification: getNotification(db, id)!, created: true, deliver: true }
      } catch (error) {
        // Two evaluators can race between the read and the insert; the unique
        // index decides the winner, and the loser joins the row it finds.
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes('UNIQUE constraint failed')) throw error
        existing = getActiveByKey(db, finding.dedupeKey)
        if (!existing) throw error
      }
    }

    const due =
      existing.state === 'open' &&
      (existing.lastNotifiedAt === null || now - existing.lastNotifiedAt >= cooldownMs)
    db.query<null, Params>(
      `UPDATE notifications SET
         occurrences = occurrences + 1,
         last_seen_at = ?,
         updated_at = ?,
         severity = ?,
         title = ?,
         body = ?,
         metadata_json = ?,
         last_notified_at = CASE WHEN ? THEN ? ELSE last_notified_at END
       WHERE id = ?`,
    ).run(
      now,
      now,
      finding.severity,
      finding.title,
      finding.body,
      finding.metadata === undefined ? null : JSON.stringify(finding.metadata),
      due ? 1 : 0,
      now,
      existing.id,
    )
    return { notification: getNotification(db, existing.id)!, created: false, deliver: due }
  }).immediate()
}

export interface ResolvedNotification {
  notification: NotificationRecord
  /** True when the operator was told about the incident, so a recovery is owed. */
  wasDelivered: boolean
}

/** Resolves every active row whose condition is gone. */
export function resolveMissingNotifications(
  db: Db,
  activeKeys: ReadonlySet<string>,
  now: number,
): ResolvedNotification[] {
  return db.transaction(() => {
    const rows = db
      .query<NotificationRecord, []>(
        `SELECT ${NOTIFICATION_SELECT} FROM notifications WHERE state IN ('open','dismissed')`,
      )
      .all()
    const resolved: ResolvedNotification[] = []
    for (const row of rows) {
      if (activeKeys.has(row.dedupeKey)) continue
      db.query<null, Params>(
        `UPDATE notifications SET state = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?`,
      ).run(now, now, row.id)
      resolved.push({
        notification: { ...row, state: 'resolved', resolvedAt: now, updatedAt: now },
        wasDelivered: row.lastNotifiedAt !== null,
      })
    }
    return resolved
  }).immediate()
}

export interface ListNotificationsOptions {
  state?: NotificationState
  limit?: number
  cursor?: string | null
}

export interface ListNotificationsResult {
  notifications: NotificationRecord[]
  nextCursor: string | null
}

function decodeCursor(cursor: string): { lastSeenAt: number; id: string } | null {
  const index = cursor.lastIndexOf(':')
  if (index <= 0) return null
  const lastSeenAt = Number(cursor.slice(0, index))
  const id = cursor.slice(index + 1)
  if (!Number.isFinite(lastSeenAt) || id === '') return null
  return { lastSeenAt, id }
}

export function listNotifications(
  db: Db,
  options: ListNotificationsOptions = {},
): ListNotificationsResult {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const where: string[] = []
  const params: SQLQueryBindings[] = []
  if (options.state) {
    where.push('state = ?')
    params.push(options.state)
  }
  const cursor = options.cursor ? decodeCursor(options.cursor) : null
  if (cursor) {
    where.push('(last_seen_at < ? OR (last_seen_at = ? AND id < ?))')
    params.push(cursor.lastSeenAt, cursor.lastSeenAt, cursor.id)
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db
    .query<NotificationRecord, Params>(
      `SELECT ${NOTIFICATION_SELECT} FROM notifications
       ${clause}
       ORDER BY last_seen_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...params, limit + 1)
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    notifications: page,
    nextCursor: rows.length > limit && last ? `${last.lastSeenAt}:${last.id}` : null,
  }
}

export function countUnread(db: Db): number {
  return (
    db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL AND state = 'open'",
      )
      .get()?.n ?? 0
  )
}

export function countNotifications(
  db: Db,
  now: number,
): { open: number; unread: number; last24h: number } {
  const row = db
    .query<{ open: number; unread: number; last24h: number }, Params>(
      `SELECT
         COALESCE(SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END), 0) AS open,
         COALESCE(SUM(CASE WHEN read_at IS NULL AND state = 'open' THEN 1 ELSE 0 END), 0) AS unread,
         COALESCE(SUM(CASE WHEN first_seen_at >= ? THEN 1 ELSE 0 END), 0) AS last24h
       FROM notifications`,
    )
    .get(now - 24 * 60 * 60_000)
  return { open: row?.open ?? 0, unread: row?.unread ?? 0, last24h: row?.last24h ?? 0 }
}

export function markNotificationRead(db: Db, id: string, now: number): NotificationRecord | null {
  db.query<null, Params>(
    `UPDATE notifications SET read_at = COALESCE(read_at, ?), updated_at = ? WHERE id = ?`,
  ).run(now, now, id)
  return getNotification(db, id)
}

/** A dismissed condition stays quiet; it resolves when the condition clears. */
export function dismissNotification(db: Db, id: string, now: number): NotificationRecord | null {
  db.query<null, Params>(
    `UPDATE notifications SET
       state = 'dismissed',
       read_at = COALESCE(read_at, ?),
       updated_at = ?
     WHERE id = ? AND state = 'open'`,
  ).run(now, now, id)
  return getNotification(db, id)
}

export function enqueueNotificationDelivery(
  db: Db,
  notificationId: string,
  messageKind: 'alert' | 'recovery',
  now: number,
): boolean {
  return (
    db
      .query<null, Params>(
        `INSERT INTO notification_delivery_attempts (
           id, notification_id, channel, message_kind, status, attempts,
           next_attempt_at, created_at, updated_at
         )
         SELECT ?, ?, 'discord', ?, 'pending', 0, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM notification_delivery_attempts
           WHERE notification_id = ? AND message_kind = ?
         )`,
      )
      .run(newId(16), notificationId, messageKind, now, now, now, notificationId, messageKind)
      .changes === 1
  )
}

export function listDueDeliveries(db: Db, now: number, limit = 20): NotificationDeliveryRecord[] {
  return db
    .query<NotificationDeliveryRecord, Params>(
      `SELECT ${DELIVERY_SELECT} FROM notification_delivery_attempts
       WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY next_attempt_at ASC, id ASC
       LIMIT ?`,
    )
    .all(now, limit)
}

export function listDeliveryAttempts(
  db: Db,
  notificationId: string,
): NotificationDeliveryRecord[] {
  return db
    .query<NotificationDeliveryRecord, Params>(
      `SELECT ${DELIVERY_SELECT} FROM notification_delivery_attempts
       WHERE notification_id = ? ORDER BY created_at ASC`,
    )
    .all(notificationId)
}

export function markDeliverySent(db: Db, id: string, now: number): void {
  db.query<null, Params>(
    `UPDATE notification_delivery_attempts SET
       status = 'sent', attempts = attempts + 1, last_error = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(now, id)
}

export function markDeliveryFailed(
  db: Db,
  id: string,
  errorMessage: string,
  now: number,
): NotificationDeliveryRecord | null {
  const row = db
    .query<NotificationDeliveryRecord, Params>(
      `SELECT ${DELIVERY_SELECT} FROM notification_delivery_attempts WHERE id = ?`,
    )
    .get(id)
  if (!row) return null
  const attempts = row.attempts + 1
  const exhausted = attempts >= DELIVERY_MAX_ATTEMPTS
  const delay =
    DELIVERY_RETRY_SCHEDULE_MS[Math.min(attempts - 1, DELIVERY_RETRY_SCHEDULE_MS.length - 1)] ??
    900_000
  db.query<null, Params>(
    `UPDATE notification_delivery_attempts SET
       attempts = ?, status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    attempts,
    exhausted ? 'failed' : 'pending',
    exhausted ? row.nextAttemptAt : now + delay,
    errorMessage.slice(0, 500),
    now,
    id,
  )
  return db
    .query<NotificationDeliveryRecord, Params>(
      `SELECT ${DELIVERY_SELECT} FROM notification_delivery_attempts WHERE id = ?`,
    )
    .get(id)
}

export function pruneNotifications(db: Db, olderThan: number): number {
  return db
    .query<null, Params>(
      "DELETE FROM notifications WHERE state IN ('resolved','dismissed') AND updated_at < ?",
    )
    .run(olderThan).changes
}
