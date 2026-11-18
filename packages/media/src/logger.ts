import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'

export type LogLevel = 'info' | 'warn' | 'error'

const SENSITIVE_KEY_RE = /(password|secret|token|cookie|authorization|auth|key)/i
const MAX_LOG_BYTES = 10 * 1024 * 1024
const MAX_ROTATED_FILES = 5

function redactValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY_RE.test(key) && typeof value === 'string') {
    return '[REDACTED]'
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(key, item))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(k, v)
    }
    return out
  }
  return value
}

function rotateIfNeeded(filePath: string): void {
  try {
    if (!existsSync(filePath)) return
    const info = statSync(filePath)
    if (info.size < MAX_LOG_BYTES) return

    const oldest = `${filePath}.${MAX_ROTATED_FILES}`
    if (existsSync(oldest)) unlinkSync(oldest)
    for (let idx = MAX_ROTATED_FILES - 1; idx >= 1; idx -= 1) {
      const src = `${filePath}.${idx}`
      if (existsSync(src)) renameSync(src, `${filePath}.${idx + 1}`)
    }
    renameSync(filePath, `${filePath}.1`)
  } catch {
    // Logging rotation must never crash the active process.
  }
}

export class StructuredLogger {
  private readonly filePath: string | null

  constructor(
    private readonly component: string,
    logDir?: string,
  ) {
    if (logDir) {
      const resolved = path.join(logDir, `${component}.log`)
      mkdirSync(logDir, { recursive: true })
      this.filePath = resolved
    } else {
      this.filePath = null
    }
  }

  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    const redacted = redactValue('', fields) as Record<string, unknown>
    const payload = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      component: this.component,
      event,
      ...redacted,
    })

    if (level === 'error') console.error(payload)
    else if (level === 'warn') console.warn(payload)
    else console.log(payload)

    if (!this.filePath) return
    try {
      rotateIfNeeded(this.filePath)
      appendFileSync(this.filePath, `${payload}\n`)
    } catch {
      // Console line is already emitted.
    }
  }

  info(event: string, fields?: Record<string, unknown>): void {
    this.log('info', event, fields)
  }

  warn(event: string, fields?: Record<string, unknown>): void {
    this.log('warn', event, fields)
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.log('error', event, fields)
  }
}
