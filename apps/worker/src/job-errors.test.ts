import { describe, expect, test } from 'bun:test'
import { classifyJobError } from './job-errors'

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error('filesystem refused'), { code })
}

describe('job error classification', () => {
  test('errno codes map onto the stable D-03 set', () => {
    expect(classifyJobError(errno('ENOSPC'))).toBe('DISK_FULL')
    expect(classifyJobError(errno('EACCES'))).toBe('PERMISSION_DENIED')
    expect(classifyJobError(errno('EPERM'))).toBe('PERMISSION_DENIED')
    expect(classifyJobError(errno('ENOENT'))).toBe('SOURCE_NOT_FOUND_CONFIRMED')
    expect(classifyJobError(errno('EISDIR'))).toBe('FILE_CORRUPT')
    expect(classifyJobError(errno('EILSEQ'))).toBe('FILE_CORRUPT')
  })

  test('named aborts and timeouts keep their own code', () => {
    const abort = new Error('cancelled')
    abort.name = 'HlsAbortedError'
    expect(classifyJobError(abort)).toBe('USER_CANCELLED')

    const timeout = new Error('process exceeded its wall clock')
    timeout.name = 'ProcessTimeoutError'
    expect(classifyJobError(timeout)).toBe('PROCESS_TIMEOUT')
  })

  test('messages are read only when the error has no code or name', () => {
    expect(classifyJobError(new Error('ffmpeg timed out after 600s'))).toBe('PROCESS_TIMEOUT')
    expect(classifyJobError(new Error('job was cancelled by user'))).toBe('USER_CANCELLED')
    expect(classifyJobError(new Error('ffmpeg: invalid data found when processing input'))).toBe(
      'FILE_CORRUPT',
    )
  })

  test('an unknown failure stays internal instead of guessing a retry', () => {
    expect(classifyJobError(new Error('cannot read properties of undefined'))).toBe('INTERNAL')
    expect(classifyJobError(null)).toBe('INTERNAL')
    expect(classifyJobError('a string, not an error')).toBe('INTERNAL')
  })
})
