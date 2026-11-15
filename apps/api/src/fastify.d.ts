import type { UserRecord } from '@mediavault/database'

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRecord | null
  }
}
