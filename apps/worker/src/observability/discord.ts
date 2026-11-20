import {
  getNotification,
  listDueDeliveries,
  markDeliveryFailed,
  markDeliverySent,
  type Db,
  type NotificationDeliveryRecord,
} from '@mediavault/database'
import type { StructuredLogger } from '@mediavault/media'
import type { WorkerConfig } from '../config'

const DISCORD_CONTENT_LIMIT = 1900

const SEVERITY_LABEL: Record<string, string> = {
  info: '안내',
  warning: '경고',
  critical: '심각',
}

export interface DiscordMessage {
  content: string
}

/** The webhook URL is a secret: it is passed to fetch and never logged. */
export function buildDiscordMessage(
  db: Db,
  delivery: NotificationDeliveryRecord,
): DiscordMessage | null {
  const notification = getNotification(db, delivery.notificationId)
  if (!notification) return null

  const heading =
    delivery.messageKind === 'recovery'
      ? `[복구] ${notification.title}`
      : `[${SEVERITY_LABEL[notification.severity] ?? notification.severity}] ${notification.title}`
  const body =
    delivery.messageKind === 'recovery'
      ? '조건이 해소되어 알림을 종료합니다.'
      : `${notification.body}\n발생 ${notification.occurrences}회`
  const content = `${heading}\n${body}`
  return { content: content.slice(0, DISCORD_CONTENT_LIMIT) }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // A fetch error can echo the URL in its message; keep only the leading reason.
  return message.split(' ').slice(0, 12).join(' ').slice(0, 300)
}

export interface DeliverySummary {
  sent: number
  failed: number
}

/**
 * One attempt per due row. The retry schedule lives in the store; this only
 * decides success or failure, so a Discord outage never loses the alert row.
 */
export async function deliverDueNotifications(
  db: Db,
  config: WorkerConfig,
  logger: StructuredLogger,
  now = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<DeliverySummary> {
  const summary: DeliverySummary = { sent: 0, failed: 0 }
  const webhook = config.discordWebhookUrl?.trim()
  if (!webhook) return summary

  for (const delivery of listDueDeliveries(db, now)) {
    const message = buildDiscordMessage(db, delivery)
    if (!message) {
      markDeliveryFailed(db, delivery.id, 'notification row is missing', now)
      summary.failed += 1
      continue
    }

    try {
      const response = await fetchImpl(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
      })
      if (!response.ok) throw new Error(`discord responded ${response.status}`)
      markDeliverySent(db, delivery.id, now)
      summary.sent += 1
    } catch (error) {
      const updated = markDeliveryFailed(db, delivery.id, errorMessage(error), now)
      summary.failed += 1
      logger.warn('worker.notification.delivery_failed', {
        notificationId: delivery.notificationId,
        messageKind: delivery.messageKind,
        status: updated?.status ?? 'unknown',
        errorMessage: errorMessage(error),
      })
    }
  }

  return summary
}
