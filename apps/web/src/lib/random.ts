/**
 * Hex token from the platform CSPRNG. `crypto.randomUUID` needs a secure
 * context, and the app is served over plain HTTP on the LAN.
 */
export function randomToken(bytes = 16): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
