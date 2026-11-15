const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

/** Lowercase base32 id that is safe in URLs and cache paths. */
export function newId(length = 12): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]
  return out
}
