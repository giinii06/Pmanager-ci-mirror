export type StartState = 'ready' | 'applied' | 'ignored'

const END_GAP_MS = 8_000

/**
 * A normal video open begins at 0. Only explicit search/bookmark timestamps
 * can move the initial playhead, never a saved playback-progress record.
 * Waiting for metadata must not allow a late seek to override the user's input.
 */
export class StartPosition {
  private state: StartState = 'ignored'
  private positionMs = 0

  constructor(explicitStartMs: number | null) {
    this.override(explicitStartMs)
  }

  get current(): StartState {
    return this.state
  }

  override(positionMs: number | null): void {
    if (positionMs !== null && Number.isFinite(positionMs) && positionMs > 0) {
      this.positionMs = positionMs
      this.state = 'ready'
    } else {
      this.positionMs = 0
      this.state = 'ignored'
    }
  }

  /** Applies a valid explicit timestamp exactly once when metadata is usable. */
  take(durationMs: number): number | null {
    if (this.state !== 'ready') return null
    if (!Number.isFinite(durationMs) || durationMs <= 0) return null
    this.state = 'applied'
    if (this.positionMs >= durationMs - END_GAP_MS) return null
    return this.positionMs
  }

  /** A manual seek takes precedence over a pending timestamp. */
  userSeek(): void {
    if (this.state === 'ready') this.state = 'ignored'
  }
}
