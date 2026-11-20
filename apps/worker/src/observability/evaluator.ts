import {
  enqueueNotificationDelivery,
  pruneNotifications,
  pruneWorkerHeartbeats,
  resolveMissingNotifications,
  upsertNotification,
  type Db,
} from '@mediavault/database'
import type { StructuredLogger } from '@mediavault/media'
import type { WorkerConfig } from '../config'
import { collectAlertFindings } from './checks'
import { deliverDueNotifications } from './discord'

const NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60_000
const HEARTBEAT_RETENTION_MS = 7 * 24 * 60 * 60_000

export interface EvaluationSummary {
  opened: number
  resolved: number
  sent: number
  failed: number
}

/**
 * One pass: upsert every active finding, resolve the conditions that are gone,
 * then attempt due deliveries. Only this function writes notifications, so the
 * checks stay side-effect free and testable.
 */
export async function runAlertEvaluation(
  db: Db,
  config: WorkerConfig,
  logger: StructuredLogger,
  now = Date.now(),
): Promise<EvaluationSummary> {
  const findings = await collectAlertFindings(db, config, now)
  const activeKeys = new Set(findings.map((finding) => finding.dedupeKey))
  const canDeliver = (config.discordWebhookUrl?.trim() ?? '') !== ''

  let opened = 0
  for (const finding of findings) {
    const { notification, created, deliver } = upsertNotification(
      db,
      {
        kind: finding.kind,
        severity: finding.severity,
        dedupeKey: finding.dedupeKey,
        title: finding.title,
        body: finding.body,
        metadata: finding.metadata,
      },
      now,
      finding.cooldownMs,
    )
    if (created) opened += 1
    if (deliver && canDeliver) {
      enqueueNotificationDelivery(db, notification.id, 'alert', now)
    }
  }

  const resolved = resolveMissingNotifications(db, activeKeys, now)
  for (const entry of resolved) {
    if (entry.wasDelivered && canDeliver) {
      enqueueNotificationDelivery(db, entry.notification.id, 'recovery', now)
    }
  }

  const delivery = await deliverDueNotifications(db, config, logger, now)

  if (opened > 0 || resolved.length > 0) {
    logger.info('worker.notifications.evaluated', {
      active: findings.length,
      opened,
      resolved: resolved.length,
    })
  }

  return { opened, resolved: resolved.length, sent: delivery.sent, failed: delivery.failed }
}

/** The evaluator runs beside the job loop and never touches a file. */
export async function runAlertLoop(
  db: Db,
  config: WorkerConfig,
  logger: StructuredLogger,
  signal: AbortSignal,
): Promise<void> {
  if (!config.notificationsEnabled) return
  const interval = config.alertIntervalMs ?? 30_000

  while (!signal.aborted) {
    try {
      await runAlertEvaluation(db, config, logger)
      const now = Date.now()
      pruneNotifications(db, now - NOTIFICATION_RETENTION_MS)
      pruneWorkerHeartbeats(db, now - HEARTBEAT_RETENTION_MS)
    } catch (error) {
      logger.error('worker.notifications.failed', {
        errorMessage: (error as Error).message,
      })
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, interval)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
  }
}
