import type { RequestMetricDTO } from '@mediavault/shared'

const MAX_SAMPLES_PER_ROUTE = 512

interface RouteBucket {
  durations: number[]
  count: number
  errors: number
  clientErrors: number
}

function percentile(sorted: number[], share: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * share) - 1))
  return sorted[index]!
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * Per-route latency in memory only. A fixed sample cap keeps a long-running
 * process bounded without a retention job; the diagnostics report carries the
 * same numbers so an operator never needs a metrics service for this host.
 */
export class RequestMetrics {
  private readonly since = Date.now()
  private readonly buckets = new Map<string, RouteBucket>()

  record(method: string, route: string, status: number, durationMs: number): void {
    const key = `${method} ${route}`
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { durations: [], count: 0, errors: 0, clientErrors: 0 }
      this.buckets.set(key, bucket)
    }
    bucket.count += 1
    if (status >= 500) bucket.errors += 1
    else if (status >= 400) bucket.clientErrors += 1
    bucket.durations.push(durationMs)
    if (bucket.durations.length > MAX_SAMPLES_PER_ROUTE) bucket.durations.shift()
  }

  snapshot(): RequestMetricDTO[] {
    const rows: RequestMetricDTO[] = []
    for (const [key, bucket] of this.buckets) {
      const space = key.indexOf(' ')
      const sorted = [...bucket.durations].sort((a, b) => a - b)
      rows.push({
        method: key.slice(0, space),
        route: key.slice(space + 1),
        count: bucket.count,
        errors: bucket.errors,
        clientErrors: bucket.clientErrors,
        p50Ms: round(percentile(sorted, 0.5)),
        p95Ms: round(percentile(sorted, 0.95)),
        maxMs: round(sorted[sorted.length - 1] ?? 0),
      })
    }
    return rows.sort((a, b) => b.count - a.count)
  }

  sinceIso(): string {
    return new Date(this.since).toISOString()
  }
}

/** The short id a user reads off an error and an operator greps for. */
export function diagnosticIdOf(requestId: string): string {
  return requestId.slice(0, 8)
}

/** Used only when a test builds an app context without one. */
export const defaultMetrics = new RequestMetrics()
