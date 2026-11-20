import { getSqliteRuntimeInfo } from '@mediavault/database'
import type { AppContext } from './context'

const INTEGRITY_TTL_MS = 60_000

const caches = new WeakMap<object, { expiresAt: number; value: string }>()

/** `PRAGMA quick_check` scans pages, so every surface shares one 60 s answer per database. */
export function sqliteIntegrity(ctx: AppContext, now = Date.now()): string {
  const cached = caches.get(ctx.db)
  if (cached && now < cached.expiresAt) return cached.value
  const value = getSqliteRuntimeInfo(ctx.db, { checkIntegrity: true }).integrity
  caches.set(ctx.db, { expiresAt: now + INTEGRITY_TTL_MS, value })
  return value
}

/** The last checked value, for a readiness probe that must stay fast. */
export function peekIntegrity(ctx: AppContext): string | null {
  return caches.get(ctx.db)?.value ?? null
}
