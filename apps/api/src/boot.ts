/** One boot time for every surface that reports uptime. */
export const BOOT_AT_MS = Date.now()
export const BOOT_AT_ISO = new Date(BOOT_AT_MS).toISOString()

export function uptimeSeconds(now = Date.now()): number {
  return Math.max(0, Math.floor((now - BOOT_AT_MS) / 1000))
}
