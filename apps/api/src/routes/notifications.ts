import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  countNotifications,
  dismissNotification,
  getNotification,
  listDeliveryAttempts,
  listNotifications,
  markNotificationRead,
} from '@mediavault/database'
import type { NotificationUnreadDTO } from '@mediavault/shared'
import type { AppContext } from '../context'
import { toNotificationDTO } from '../dto'
import { parseInput } from '../validate'

const listQuery = z.object({
  state: z.enum(['open', 'resolved', 'dismissed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
})
const idParams = z.object({ id: z.string().min(1) })

export function registerNotificationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const enabled = (): boolean => ctx.config.notificationsEnabled === true

  app.get('/api/notifications', async (request, reply) => {
    if (!enabled()) {
      reply.code(404).send({ error: 'not_found', message: 'Notifications are disabled.' })
      return
    }
    const query = parseInput(listQuery, request.query, reply)
    if (!query) return
    const result = listNotifications(ctx.db, {
      state: query.state,
      limit: query.limit,
      cursor: query.cursor,
    })
    reply.send({
      notifications: result.notifications.map(toNotificationDTO),
      nextCursor: result.nextCursor,
    })
  })

  app.get('/api/notifications/unread', async (_request, reply) => {
    if (!enabled()) {
      reply.code(404).send({ error: 'not_found', message: 'Notifications are disabled.' })
      return
    }
    const counts = countNotifications(ctx.db, Date.now())
    const payload: NotificationUnreadDTO = { unread: counts.unread, open: counts.open }
    reply.send(payload)
  })

  app.get('/api/notifications/:id', async (request, reply) => {
    if (!enabled()) {
      reply.code(404).send({ error: 'not_found', message: 'Notifications are disabled.' })
      return
    }
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const notification = getNotification(ctx.db, params.id)
    if (!notification) {
      reply.code(404).send({ error: 'not_found', message: 'Notification not found.' })
      return
    }
    reply.send({
      notification: toNotificationDTO(notification),
      deliveries: listDeliveryAttempts(ctx.db, notification.id),
    })
  })

  app.post('/api/notifications/:id/read', async (request, reply) => {
    if (!enabled()) {
      reply.code(404).send({ error: 'not_found', message: 'Notifications are disabled.' })
      return
    }
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const notification = markNotificationRead(ctx.db, params.id, Date.now())
    if (!notification) {
      reply.code(404).send({ error: 'not_found', message: 'Notification not found.' })
      return
    }
    reply.send({ notification: toNotificationDTO(notification) })
  })

  app.post('/api/notifications/:id/dismiss', async (request, reply) => {
    if (!enabled()) {
      reply.code(404).send({ error: 'not_found', message: 'Notifications are disabled.' })
      return
    }
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const notification = dismissNotification(ctx.db, params.id, Date.now())
    if (!notification) {
      reply.code(404).send({ error: 'not_found', message: 'Notification not found.' })
      return
    }
    reply.send({ notification: toNotificationDTO(notification) })
  })
}
