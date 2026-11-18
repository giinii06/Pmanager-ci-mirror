import type { AssetCursor } from '@mediavault/database'

const CURSOR_ID = /^[a-z0-9]{6,32}$/

export function encodeCursor(cursor: AssetCursor): string {
  if ('offset' in cursor) {
    return Buffer.from(`off:${cursor.offset}`, 'utf8').toString('base64url')
  }
  return Buffer.from(`${cursor.takenAt}:${cursor.id}`, 'utf8').toString('base64url')
}

export function decodeCursor(raw: string): AssetCursor | null {
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8')
    if (text.startsWith('off:')) {
      const offset = Number(text.slice(4))
      if (!Number.isInteger(offset) || offset < 0) return null
      return { offset }
    }
    const separator = text.indexOf(':')
    if (separator <= 0) return null
    const takenAt = Number(text.slice(0, separator))
    const id = text.slice(separator + 1)
    if (!Number.isFinite(takenAt) || !CURSOR_ID.test(id)) return null
    return { takenAt, id }
  } catch {
    return null
  }
}
