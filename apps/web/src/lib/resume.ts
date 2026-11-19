export type ResumeState = 'pending' | 'ready' | 'applied' | 'ignored'

const MIN_RESUME_MS = 5_000
const END_GAP_MS = 8_000

/**
 * Decides where a newly opened video starts. The saved position may only be
 * applied while nothing else owns the playhead; a late response, a user seek
 * or an explicit start must all be able to win, and each may happen in any
 * order. This mirrors C-05's pending/ready/applied/ignored state machine.
 */
export class ResumePosition {
  private state: ResumeState
  private positionMs = 0

  constructor(explicitStartMs: number | null) {
    if (explicitStartMs && explicitStartMs > 0) {
      this.state = 'ready'
      this.positionMs = explicitStartMs
    } else {
      this.state = 'pending'
    }
  }

  get current(): ResumeState {
    return this.state
  }

  /**
   * Offers a fetched position. Returns it when it became the candidate, or
   * null when the playhead is already owned or the record is unusable.
   */
  offer(positionMs: number, fileVersionMatches: boolean): number | null {
    if (this.state !== 'pending') return null
    if (!fileVersionMatches || positionMs <= MIN_RESUME_MS) {
      this.state = 'ignored'
      return null
    }
    this.state = 'ready'
    this.positionMs = positionMs
    return positionMs
  }

  /** A search hit's timestamp outranks anything already decided. */
  override(positionMs: number): void {
    this.state = 'ready'
    this.positionMs = positionMs
  }

  /**
   * Takes the candidate once metadata is available. A position at the very end
   * is treated as finished and not replayed.
   */
  take(durationMs: number): number | null {
    if (this.state !== 'ready') return null
    if (!Number.isFinite(durationMs) || durationMs <= 0) return null
    this.state = 'applied'
    if (this.positionMs <= 0 || this.positionMs >= durationMs - END_GAP_MS) return null
    return this.positionMs
  }

  /** A seek before the candidate was applied cancels it. */
  userSeek(): void {
    if (this.state === 'pending' || this.state === 'ready') this.state = 'ignored'
  }
}
