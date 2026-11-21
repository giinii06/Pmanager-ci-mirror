import { describe, expect, test } from 'bun:test'
import type { FileOperationState } from '@mediavault/shared'
import { monitorBackgroundDelete } from './backgroundDelete'

const immediate = async () => {}

describe('background deletion status', () => {
  test('does not wait for deletion to be complete before the UI can acknowledge it', async () => {
    const seen: FileOperationState[] = ['requested', 'validated', 'quarantined', 'completed']
    let calls = 0
    const result = await monitorBackgroundDelete(async () => seen[calls++]!, immediate)
    expect(result).toBe('completed')
    expect(calls).toBe(4)
  })

  test('reports a blocked delete to the UI after initial acceptance', async () => {
    expect(await monitorBackgroundDelete(async () => 'blocked', immediate)).toBe('failed')
    expect(await monitorBackgroundDelete(async () => 'cancelled_pre_commit', immediate)).toBe('failed')
  })

  test('keeps monitoring recoverable worker and network errors', async () => {
    let calls = 0
    const result = await monitorBackgroundDelete(async () => {
      calls += 1
      if (calls === 1) throw new Error('temporary network outage')
      if (calls === 2) return 'failed_retryable'
      return 'completed'
    }, immediate)
    expect(result).toBe('completed')
    expect(calls).toBe(3)
  })

  test('stops checking eventually without claiming the worker failed', async () => {
    let checks = 0
    const result = await monitorBackgroundDelete(async () => {
      checks += 1
      return 'requested'
    }, immediate, 3)
    expect(result).toBe('unresolved')
    expect(checks).toBe(3)
  })
})
