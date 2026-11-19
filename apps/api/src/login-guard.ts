import {
  countLoginAttempts,
  countLoginFailures,
  finishLoginAttempt,
  insertLoginAttempt,
  oldestLoginAttempt,
  oldestLoginFailure,
  pruneLoginAttempts,
  type Db,
  type LoginOutcome,
} from '@mediavault/database'

export const LOGIN_WINDOW_MS = 15 * 60_000
export const LOGIN_MAX_FAILURES_PER_USER = 10
export const LOGIN_MAX_ATTEMPTS_PER_IP = 30
const ATTEMPT_RETENTION_MS = 24 * 60 * 60_000

export interface LoginLimits {
  windowMs: number
  maxFailuresPerUser: number
  maxAttemptsPerIp: number
}

const DEFAULT_LIMITS: LoginLimits = {
  windowMs: LOGIN_WINDOW_MS,
  maxFailuresPerUser: LOGIN_MAX_FAILURES_PER_USER,
  maxAttemptsPerIp: LOGIN_MAX_ATTEMPTS_PER_IP,
}

export type LoginAdmission =
  | { admitted: true; attemptId: number }
  | { admitted: false; retryAfterSeconds: number }

let lastPrune = 0

function retryAfter(now: number, oldest: number | null, windowMs: number): number {
  if (oldest === null) return Math.ceil(windowMs / 1000)
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
}

/**
 * Admission is reserved before the password hash runs, so a burst of concurrent
 * requests cannot all pass the same count and multiply the KDF cost. The row is
 * updated to its outcome once verification finishes.
 */
export function admitLogin(
  db: Db,
  input: { username: string; ip: string; now: number },
  limits: LoginLimits = DEFAULT_LIMITS,
): LoginAdmission {
  const since = input.now - limits.windowMs
  const admission = db.transaction(() => {
    if (countLoginAttempts(db, input.ip, since) >= limits.maxAttemptsPerIp) {
      return {
        admitted: false as const,
        retryAfterSeconds: retryAfter(
          input.now,
          oldestLoginAttempt(db, input.ip, since),
          limits.windowMs,
        ),
      }
    }
    if (countLoginFailures(db, input.username, since) >= limits.maxFailuresPerUser) {
      return {
        admitted: false as const,
        retryAfterSeconds: retryAfter(
          input.now,
          oldestLoginFailure(db, input.username, since),
          limits.windowMs,
        ),
      }
    }
    return {
      admitted: true as const,
      attemptId: insertLoginAttempt(db, {
        username: input.username,
        ip: input.ip,
        createdAt: input.now,
      }),
    }
  }).immediate()

  if (input.now - lastPrune > 60 * 60_000) {
    lastPrune = input.now
    pruneLoginAttempts(db, input.now - ATTEMPT_RETENTION_MS)
  }
  return admission
}

export function finishLogin(db: Db, attemptId: number, outcome: LoginOutcome): void {
  finishLoginAttempt(db, attemptId, outcome)
}
