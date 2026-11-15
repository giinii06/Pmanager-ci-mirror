import type { FastifyReply } from 'fastify'
import type { z } from 'zod'

export function parseInput<T>(
  schema: z.ZodType<T>,
  data: unknown,
  reply: FastifyReply,
): T | null {
  const result = schema.safeParse(data)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const path = issue?.path.join('.')
  reply.code(400).send({
    error: 'invalid_request',
    message: issue ? `${path ? `${path}: ` : ''}${issue.message}` : 'Invalid request.',
  })
  return null
}
