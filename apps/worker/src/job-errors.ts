import type { JobErrorCode } from '@mediavault/shared'

/**
 * Maps a thrown error onto the stable D-03 set. The mapping is deliberately
 * conservative: an unknown failure is `INTERNAL`, not a retryable guess, so a
 * bug is never disguised as a transient source problem.
 */
export function classifyJobError(error: unknown): JobErrorCode {
  const err = error as (NodeJS.ErrnoException & { name?: string; message?: string }) | null
  switch (err?.code) {
    case 'ENOSPC':
      return 'DISK_FULL'
    case 'EACCES':
    case 'EPERM':
      return 'PERMISSION_DENIED'
    case 'ENOENT':
      return 'SOURCE_NOT_FOUND_CONFIRMED'
    case 'ENOTDIR':
    case 'EISDIR':
    case 'EILSEQ':
      return 'FILE_CORRUPT'
    default:
      break
  }

  const name = err?.name ?? ''
  const message = err?.message ?? ''
  if (name === 'HlsAbortedError') return 'USER_CANCELLED'
  if (name === 'ProcessTimeoutError') return 'PROCESS_TIMEOUT'
  if (/aborted|cancelled by user/i.test(message)) return 'USER_CANCELLED'
  if (/timed out|timeout/i.test(message)) return 'PROCESS_TIMEOUT'
  if (/(ffmpeg|ffprobe)/i.test(message) && /(invalid|corrupt|moov atom|decode)/i.test(message)) {
    return 'FILE_CORRUPT'
  }
  return 'INTERNAL'
}
