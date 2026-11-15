import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const KEY_LENGTH = 64
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1

export const SESSION_COOKIE = 'mv_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

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
  const salt = randomBytes(16)
  const key = await derive(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  const salt = Buffer.from(parts[4] ?? '', 'base64url')
  const expected = Buffer.from(parts[5] ?? '', 'base64url')
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false
  if (salt.length === 0 || expected.length === 0) return false

  const key = await derive(password, salt, expected.length, { N: n, r, p })
  return key.length === expected.length && timingSafeEqual(key, expected)
}

export function createSessionToken(
  userId: string,
  secret: string,
  ttlMs = SESSION_TTL_MS,
  now = Date.now(),
): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: now + ttlMs })).toString('base64url')
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

export function verifySessionToken(
  token: string,
  secret: string,
  now = Date.now(),
): string | null {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(payload).digest('base64url')
  const given = Buffer.from(signature)
  const wanted = Buffer.from(expected)
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      u?: unknown
      e?: unknown
    }
    if (typeof data.u !== 'string' || typeof data.e !== 'number') return null
    if (data.e < now) return null
    return data.u
  } catch {
    return null
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!header) return cookies
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name) cookies[name] = decodeURIComponent(value)
  }
  return cookies
}

export function sessionCookie(token: string, secure: boolean): string {
  const flags = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ]
  if (secure) flags.push('Secure')
  return flags.join('; ')
}

export function clearSessionCookie(secure: boolean): string {
  const flags = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ]
  if (secure) flags.push('Secure')
  return flags.join('; ')
}
