import type { FastifyReply } from 'fastify'
import { parseFilterTree, type FilterTree } from '@mediavault/shared'

/**
 * Validates a filter tree with the same function the database uses to read a
 * stored album, so a filter that passes here is a filter the compiler accepts.
 */
export function parseFilterBody(input: unknown, reply: FastifyReply): FilterTree | null {
  const parsed = parseFilterTree(input)
  if (parsed.ok) return parsed.tree
  reply.code(400).send({ error: 'invalid_request', message: parsed.error })
  return null
}
