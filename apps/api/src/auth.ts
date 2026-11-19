import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import {
  deleteStaleSessions,
  findSessionByDigest,
  findUserById,
  insertSession,
  revokeSession,
  touchSession,
  type Db,
  type UserRecord,
} from '@mediavault/database'
import { newId } from '@mediavault/shared'

const KEY_LENGTH = 64
const SALT_LENGTH = 16
const SCRYPT_PROFILE = { N: 16384, r: 8, p: 1 } as const

export const SESSION_COOKIE = 'mv_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const SESSION_TOUCH_MS = 5 * 60_000

// 32 random bytes, base64url: cookie-safe without percent-encoding.
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/
const SESSION_ID = /^[a-z0-9]{6,32}$/
const COOKIE_NAME = /^[A-Za-z0-9_.-]{1,64}$/
const MAX_COOKIE_HEADER = 8192
const MAX_COOKIE_VALUE = 512

/**
 * Argon2id at OWASP's documented starting point. Logins are rare, and 64 MiB
 * keeps a single verification well under 150 ms on this host.
 */
const PASSWORD_HASH = { algorithm: 'argon2id', memoryCost: 65536, timeCost: 2 } as const

function derive(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, PASSWORD_HASH)
}

export interface PasswordCheck {
  ok: boolean
  /** A legacy hash verified; rewrite it with the current algorithm. */
  needsRehash: boolean
}

/**
 * Verifies both hash formats. A stored hash that does not match the documented
 * profile is a failed login, not an exception: a corrupted row must not turn
 * into a 500, and a huge N/r/p must not become a memory bomb.
 */
export async function verifyPassword(password: string, stored: string): Promise<PasswordCheck> {
  if (stored.startsWith('$argon2')) {
    try {
      return { ok: await Bun.password.verify(password, stored), needsRehash: false }
    } catch {
      return { ok: false, needsRehash: false }
    }
  }
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return { ok: false, needsRehash: false }

  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (n !== SCRYPT_PROFILE.N || r !== SCRYPT_PROFILE.r || p !== SCRYPT_PROFILE.p) {
    return { ok: false, needsRehash: false }
  }
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64url')
    expected = Buffer.from(parts[5] ?? '', 'base64url')
  } catch {
    return { ok: false, needsRehash: false }
  }
  if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) {
    return { ok: false, needsRehash: false }
  }
  try {
    const key = await derive(password, salt, expected.length, SCRYPT_PROFILE)
    return { ok: timingSafeEqual(key, expected), needsRehash: true }
  } catch {
    return { ok: false, needsRehash: false }
  }
}

/**
 * Unknown usernames must spend the same work as a real check. The dummy hash is
 * built once per process and never matches a submitted password.
 */
let dummyHash: Promise<string> | null = null
export async function spendPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'))
  await verifyPassword(password, await dummyHash)
}

export function sessionDigest(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('hex')
}

export interface IssuedSession {
  token: string
  id: string
  expiresAt: number
}

let lastSessionPrune = 0

export function createSession(
  db: Db,
  userId: string,
  secret: string,
  options: { userAgent?: string | null; now?: number; ttlMs?: number } = {},
): IssuedSession {
  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS
  const token = randomBytes(32).toString('base64url')
  const id = newId()
  const userAgent = options.userAgent?.replace(/[\u0000-\u001f]/g, '').slice(0, 256) || null

  insertSession(db, {
    id,
    userId,
    tokenDigest: sessionDigest(token, secret),
    userAgent,
    createdAt: now,
    expiresAt: now + ttlMs,
  })

  if (now - lastSessionPrune > 60 * 60_000) {
    lastSessionPrune = now
    deleteStaleSessions(db, now - 7 * 24 * 60 * 60_000)
  }
  return { token, id, expiresAt: now + ttlMs }
}

export interface ResolvedSession {
  user: UserRecord
  sessionId: string
}

/**
 * The token is opaque; the indexed digest lookup decides validity. `last_seen`
 * advances at most once per five minutes and never extends the expiry.
 */
export function resolveSession(
  db: Db,
  token: string | undefined,
  secret: string,
  now = Date.now(),
): ResolvedSession | null {
  if (!token || !SESSION_TOKEN.test(token)) return null
  const session = findSessionByDigest(db, sessionDigest(token, secret), now)
  if (!session) return null
  const user = findUserById(db, session.userId)
  if (!user) return null
  try {
    touchSession(db, session.id, now, SESSION_TOUCH_MS)
  } catch {
    // Activity metadata is not worth failing an authorized request over.
  }
  return { user, sessionId: session.id }
}

export function revokeSessionById(
  db: Db,
  sessionId: string,
  now = Date.now(),
  userId?: string,
): boolean {
  if (!SESSION_ID.test(sessionId)) return false
  return revokeSession(db, sessionId, now, userId)
}

/** `HttpOnly` keeps the token away from scripts; `Strict` keeps it off cross-site requests. */
export function sessionCookie(token: string, secure: boolean, ttlMs = SESSION_TTL_MS): string {
  return cookieHeader(token, secure, Math.floor(ttlMs / 1000))
}

export function clearSessionCookie(secure: boolean): string {
  return cookieHeader('', secure, 0)
}

function cookieHeader(value: string, secure: boolean, maxAgeSeconds: number): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * A malformed cookie header must never throw. The only cookie the server reads
 * is a base64url token, so no percent-decoding is applied to it.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!header || header.length > MAX_COOKIE_HEADER) return cookies
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    if (!COOKIE_NAME.test(name) || name in cookies) continue
    const value = part.slice(eq + 1).trim()
    if (value.length > MAX_COOKIE_VALUE) continue
    cookies[name] = value
  }
  return cookies
}
