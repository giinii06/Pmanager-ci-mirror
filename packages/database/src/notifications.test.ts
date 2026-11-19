import { describe, expect, test } from 'bun:test'
import {
  countNotifications,
  countUnread,
  dismissNotification,
  enqueueNotificationDelivery,
  getNotification,
  listDeliveryAttempts,
  listDueDeliveries,
  listNotifications,
  markDeliveryFailed,
  markDeliverySent,
  markNotificationRead,
  openDatabase,
  pruneNotifications,
  resolveMissingNotifications,
  upsertNotification,
  type Db,
  type NotificationFinding,
} from './index'

const COOLDOWN = 60_000

function finding(overrides: Partial<NotificationFinding> = {}): NotificationFinding {
  return {
    kind: 'disk_low',
    severity: 'warning',
    dedupeKey: 'disk:cache',
    title: 'Cache volume is low',
    body: '3% free',
    metadata: { volume: 'cache' },
    ...overrides,
  }
}

function freshDb(): Db {
  return openDatabase(':memory:')
}

describe('notifications', () => {
  test('one incident keeps one row and respects the cooldown', () => {
    const db = freshDb()
    const first = upsertNotification(db, finding(), 1_000, COOLDOWN)
    expect(first.created).toBe(true)
    expect(first.deliver).toBe(true)

    const repeat = upsertNotification(db, finding({ body: '2% free' }), 30_000, COOLDOWN)
    expect(repeat.created).toBe(false)
    expect(repeat.deliver).toBe(false)
    expect(repeat.notification.id).toBe(first.notification.id)
    expect(repeat.notification.occurrences).toBe(2)
    expect(repeat.notification.lastSeenAt).toBe(30_000)
    expect(repeat.notification.body).toBe('2% free')

    const afterCooldown = upsertNotification(db, finding(), 1_000 + COOLDOWN, COOLDOWN)
    expect(afterCooldown.deliver).toBe(true)
    expect(afterCooldown.notification.lastNotifiedAt).toBe(1_000 + COOLDOWN)
    expect(listNotifications(db).notifications).toHaveLength(1)
    db.close()
  })

  test('a dismissed incident stays quiet until it resolves', () => {
    const db = freshDb()
    const opened = upsertNotification(db, finding(), 1_000, COOLDOWN)
    expect(dismissNotification(db, opened.notification.id, 2_000)?.state).toBe('dismissed')

    const repeat = upsertNotification(db, finding(), 500_000, COOLDOWN)
    expect(repeat.created).toBe(false)
    expect(repeat.deliver).toBe(false)
    expect(repeat.notification.state).toBe('dismissed')
    expect(repeat.notification.occurrences).toBe(2)
    expect(listNotifications(db).notifications).toHaveLength(1)
    db.close()
  })

  test('resolving frees the dedupe key so a later incident opens a new row', () => {
    const db = freshDb()
    const opened = upsertNotification(db, finding(), 1_000, COOLDOWN)

    const resolved = resolveMissingNotifications(db, new Set(), 5_000)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.notification.state).toBe('resolved')
    expect(resolved[0]!.wasDelivered).toBe(true)

    const reopened = upsertNotification(db, finding(), 6_000, COOLDOWN)
    expect(reopened.created).toBe(true)
    expect(reopened.notification.id).not.toBe(opened.notification.id)
    expect(listNotifications(db, { state: 'open' }).notifications).toHaveLength(1)
    expect(listNotifications(db, { state: 'resolved' }).notifications).toHaveLength(1)
    db.close()
  })

  test('an undelivered alert resolves without owing a recovery', () => {
    const db = freshDb()
    upsertNotification(db, finding(), 1_000, COOLDOWN)
    db.query('UPDATE notifications SET last_notified_at = NULL').run()
    const resolved = resolveMissingNotifications(db, new Set(), 2_000)
    expect(resolved[0]!.wasDelivered).toBe(false)
    db.close()
  })

  test('unread count follows read_at and open state', () => {
    const db = freshDb()
    const one = upsertNotification(db, finding(), 1_000, COOLDOWN)
    upsertNotification(db, finding({ dedupeKey: 'disk:media', title: 'Media low' }), 1_000, COOLDOWN)
    expect(countUnread(db)).toBe(2)

    markNotificationRead(db, one.notification.id, 2_000)
    expect(countUnread(db)).toBe(1)
    expect(getNotification(db, one.notification.id)?.readAt).toBe(2_000)

    dismissNotification(db, one.notification.id, 3_000)
    expect(countUnread(db)).toBe(1)
    expect(countNotifications(db, 4_000)).toEqual({ open: 1, unread: 1, last24h: 2 })
    db.close()
  })

  test('lists newest first and paginates with a cursor', () => {
    const db = freshDb()
    for (let index = 0; index < 3; index += 1) {
      upsertNotification(
        db,
        finding({ dedupeKey: `disk:v${index}`, title: `Volume ${index}` }),
        1_000 + index * 1_000,
        COOLDOWN,
      )
    }
    const first = listNotifications(db, { limit: 2 })
    expect(first.notifications.map((row) => row.title)).toEqual(['Volume 2', 'Volume 1'])
    expect(first.nextCursor).not.toBeNull()

    const second = listNotifications(db, { limit: 2, cursor: first.nextCursor })
    expect(second.notifications.map((row) => row.title)).toEqual(['Volume 0'])
    expect(second.nextCursor).toBeNull()
    db.close()
  })

  test('delivery retries at 1m and 5m, then fails', () => {
    const db = freshDb()
    const opened = upsertNotification(db, finding(), 1_000, COOLDOWN)
    expect(enqueueNotificationDelivery(db, opened.notification.id, 'alert', 1_000)).toBe(true)
    // A second enqueue for the same message is a no-op.
    expect(enqueueNotificationDelivery(db, opened.notification.id, 'alert', 1_000)).toBe(false)

    const due = listDueDeliveries(db, 1_000)
    expect(due).toHaveLength(1)
    expect(listDueDeliveries(db, 999)).toHaveLength(0)

    const firstFailure = markDeliveryFailed(db, due[0]!.id, 'connect timeout', 1_000)
    expect(firstFailure?.status).toBe('pending')
    expect(firstFailure?.attempts).toBe(1)
    expect(firstFailure?.nextAttemptAt).toBe(61_000)
    expect(listDueDeliveries(db, 60_999)).toHaveLength(0)

    const secondFailure = markDeliveryFailed(db, due[0]!.id, 'connect timeout', 61_000)
    expect(secondFailure?.attempts).toBe(2)
    expect(secondFailure?.nextAttemptAt).toBe(61_000 + 300_000)

    const thirdFailure = markDeliveryFailed(db, due[0]!.id, 'connect timeout', 361_000)
    expect(thirdFailure?.status).toBe('failed')
    expect(thirdFailure?.attempts).toBe(3)
    expect(listDueDeliveries(db, 10_000_000)).toHaveLength(0)

    expect(listDeliveryAttempts(db, opened.notification.id)).toHaveLength(1)
    db.close()
  })

  test('a recovery message is tracked separately from the alert', () => {
    const db = freshDb()
    const opened = upsertNotification(db, finding(), 1_000, COOLDOWN)
    enqueueNotificationDelivery(db, opened.notification.id, 'alert', 1_000)
    const [alert] = listDueDeliveries(db, 1_000)
    markDeliverySent(db, alert!.id, 1_500)

    expect(enqueueNotificationDelivery(db, opened.notification.id, 'recovery', 2_000)).toBe(true)
    const recovery = listDueDeliveries(db, 2_000)
    expect(recovery).toHaveLength(1)
    expect(recovery[0]!.messageKind).toBe('recovery')
    db.close()
  })

  test('pruning drops settled rows only', () => {
    const db = freshDb()
    const opened = upsertNotification(db, finding(), 1_000, COOLDOWN)
    const settled = upsertNotification(db, finding({ dedupeKey: 'disk:data' }), 1_000, COOLDOWN)
    resolveMissingNotifications(db, new Set([finding().dedupeKey]), 2_000)

    expect(pruneNotifications(db, 2_500)).toBe(1)
    expect(getNotification(db, settled.notification.id)).toBeNull()
    expect(getNotification(db, opened.notification.id)?.state).toBe('open')
    db.close()
  })
})
