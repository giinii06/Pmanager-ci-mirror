import type { FileOperationState } from '@mediavault/shared'

export type BackgroundDeleteOutcome = 'completed' | 'failed' | 'unresolved'

const STATUS_POLL_MS = 5_000
const MAX_STATUS_POLLS = 120

/**
 * Observes a durable server-side delete without blocking the UI. A transient
 * status request failure is not a delete failure; the worker continues even
 * when the tab closes or status polling ends.
 */
export async function monitorBackgroundDelete(
  fetchState: () => Promise<FileOperationState>,
  wait: (ms: number) => Promise<void>,
  maxPolls = MAX_STATUS_POLLS,
): Promise<BackgroundDeleteOutcome> {
  for (let poll = 0; poll < maxPolls; poll += 1) {
    await wait(STATUS_POLL_MS)
    let state: FileOperationState
    try {
      state = await fetchState()
    } catch {
      continue
    }
    if (state === 'completed') return 'completed'
    if (state === 'blocked' || state === 'cancelled_pre_commit') return 'failed'
  }
  return 'unresolved'
}
