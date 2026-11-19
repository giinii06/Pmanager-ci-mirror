import type { PlayEventResultDTO, PlayEventType, PlaySessionDTO } from '@mediavault/shared'
import { ApiError, api } from './api'
import { randomToken } from './random'

interface QueuedEvent {
  eventId: string
  seq: number
  type: PlayEventType
  deltaMs?: number
  positionMs?: number
  durationMs?: number
  clientTimestamp: number
}

export interface PlaybackReporterOptions {
  assetId: string
  fileVersion: number
  onCounters: (counters: { viewCount: number; watchTimeMs: number }) => void
}

const MAX_DELTA_MS = 600_000
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]

/**
 * Owns one playback attempt's outbox. Events are sent one at a time in
 * sequence order; a failed request keeps its event id so the server can
 * recognise the retry, and a refused sequence starts a fresh session instead
 * of silently dropping the time that was watched.
 */
export class PlaybackReporter {
  private readonly assetId: string
  private readonly fileVersion: number
  private clientSessionKey = randomToken()
  private readonly onCounters: PlaybackReporterOptions['onCounters']
  private session: PlaySessionDTO | null = null
  private sessionPromise: Promise<PlaySessionDTO | null> | null = null
  private queue: QueuedEvent[] = []
  private inFlight: QueuedEvent | null = null
  private nextSeq = 1
  private viewQueued = false
  private stopped = false
  private draining = false
  private retryTimer: number | null = null
  private retryAttempt = 0

  constructor(options: PlaybackReporterOptions) {
    this.assetId = options.assetId
    this.fileVersion = options.fileVersion
    this.onCounters = options.onCounters
  }

  view(): void {
    if (this.stopped || this.viewQueued) return
    this.viewQueued = true
    this.enqueue({ type: 'view' })
    void this.drain()
  }

  watchTime(deltaMs: number): void {
    if (this.stopped) return
    const delta = Math.round(deltaMs)
    if (delta < 1) return
    const tail = this.queue[this.queue.length - 1]
    if (
      tail &&
      tail.type === 'watch_time' &&
      tail !== this.inFlight &&
      (tail.deltaMs ?? 0) + delta <= MAX_DELTA_MS
    ) {
      tail.deltaMs = (tail.deltaMs ?? 0) + delta
    } else {
      this.enqueue({ type: 'watch_time', deltaMs: Math.min(MAX_DELTA_MS, delta) })
    }
    void this.drain()
  }

  progress(positionMs: number, durationMs: number): void {
    if (this.stopped) return
    if (!Number.isFinite(positionMs) || !Number.isFinite(durationMs) || durationMs <= 0) return
    const position = Math.max(0, Math.round(positionMs))
    const duration = Math.round(durationMs)
    const tail = this.queue[this.queue.length - 1]
    if (tail && tail.type === 'progress' && tail !== this.inFlight) {
      tail.positionMs = position
      tail.durationMs = duration
    } else {
      this.enqueue({ type: 'progress', positionMs: position, durationMs: duration })
    }
    void this.drain()
  }

  /** Keepalive flush for pagehide/visibilitychange; safe to call repeatedly. */
  flush(keepalive = false): void {
    if (keepalive) {
      this.sendKeepalive()
      return
    }
    void this.drain()
  }

  dispose(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.sendKeepalive()
  }

  private enqueue(event: Omit<QueuedEvent, 'eventId' | 'seq' | 'clientTimestamp'>): void {
    this.queue.push({
      ...event,
      eventId: randomToken(),
      seq: this.nextSeq,
      clientTimestamp: Date.now(),
    })
    this.nextSeq += 1
  }

  private async ensureSession(): Promise<PlaySessionDTO | null> {
    if (this.session) return this.session
    if (this.sessionPromise) return this.sessionPromise
    this.sessionPromise = api
      .startPlaySession(this.assetId, this.fileVersion, this.clientSessionKey)
      .then((session) => {
        this.session = session
        return session
      })
      .catch((error) => {
        if (
          error instanceof ApiError &&
          [400, 401, 404, 409, 410].includes(error.status)
        ) {
          this.stopped = true
        }
        return null
      })
      .finally(() => {
        this.sessionPromise = null
      })
    return this.sessionPromise
  }

  private async drain(): Promise<void> {
    if (this.stopped || this.draining) return
    this.draining = true
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    try {
      while (!this.stopped && this.queue.length > 0) {
        const event = this.queue[0]!
        const session = await this.ensureSession()
        if (!session || this.stopped) {
          this.scheduleRetry()
          return
        }
        this.inFlight = event
        try {
          const result = await api.playEvent(session.sessionId, {
            eventId: event.eventId,
            seq: event.seq,
            type: event.type,
            deltaMs: event.deltaMs,
            positionMs: event.positionMs,
            durationMs: event.durationMs,
            clientTimestamp: event.clientTimestamp,
          })
          this.queue.shift()
          this.inFlight = null
          this.retryAttempt = 0
          this.applyResult(result)
        } catch (error) {
          this.inFlight = null
          if (!(error instanceof ApiError)) {
            this.scheduleRetry()
            return
          }
          if (error.status === 401 || error.status === 410) {
            this.stopped = true
            return
          }
          if (error.code === 'file_version_changed') {
            // The file was replaced under this player; its time and position no
            // longer describe the asset, so reporting stops without retrying.
            this.stopped = true
            return
          }
          if (error.code === 'event_id_conflict') {
            // Never reuse an id with a different payload; dropping is the only
            // safe recovery because the stored event may already be applied.
            this.queue.shift()
            this.resetSession()
            this.retryAttempt = 0
            continue
          }
          if (error.status === 400) {
            // A malformed event will never become valid; drop it so one bad
            // payload cannot block every later watch-time flush.
            this.queue.shift()
            this.retryAttempt = 0
            continue
          }
          if (
            error.status === 404 ||
            error.code === 'sequence_gap' ||
            error.code === 'sequence_conflict'
          ) {
            // The server refused this event, so it was not applied. Start a new
            // session and renumber the outbox rather than losing the time.
            this.resetSession()
            this.retryAttempt = 0
            continue
          }
          this.scheduleRetry()
          return
        }
      }
    } finally {
      this.draining = false
    }
  }

  private resetSession(): void {
    this.session = null
    // A fresh key is required: reusing the old one would return the session the
    // server already advanced, and the renumbered first event would conflict.
    this.clientSessionKey = randomToken()
    this.nextSeq = 1
    for (const queued of this.queue) {
      queued.eventId = randomToken()
      queued.seq = this.nextSeq
      this.nextSeq += 1
    }
  }

  private applyResult(result: PlayEventResultDTO): void {
    this.onCounters({ viewCount: result.viewCount, watchTimeMs: result.watchTimeMs })
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer !== null) return
    const delay =
      RETRY_DELAYS_MS[Math.min(this.retryAttempt, RETRY_DELAYS_MS.length - 1)] ?? 30_000
    this.retryAttempt += 1
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null
      void this.drain()
    }, delay)
  }

  /**
   * A page that is going away cannot await anything, so every queued event is
   * handed to the browser with keepalive. Re-sending an in-flight event is
   * safe: the server recognises its id.
   */
  private sendKeepalive(): void {
    const session = this.session
    if (!session) return
    // The in-flight event is still queue[0] until its response arrives, so the
    // queue already contains everything that needs to be sent.
    for (const event of this.queue) {
      void api
        .playEvent(
          session.sessionId,
          {
            eventId: event.eventId,
            seq: event.seq,
            type: event.type,
            deltaMs: event.deltaMs,
            positionMs: event.positionMs,
            durationMs: event.durationMs,
            clientTimestamp: event.clientTimestamp,
          },
          true,
        )
        .catch(() => undefined)
    }
  }
}
