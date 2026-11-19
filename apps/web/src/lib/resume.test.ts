import { describe, expect, test } from 'bun:test'
import { ResumePosition } from './resume'

describe('ResumePosition', () => {
  test('applies a fetched position once metadata is ready', () => {
    const resume = new ResumePosition(null)
    expect(resume.offer(60_000, true)).toBe(60_000)
    expect(resume.take(120_000)).toBe(60_000)
    expect(resume.current).toBe('applied')
    expect(resume.take(120_000)).toBeNull()
  })

  test('a late response cannot overwrite an applied position', () => {
    const resume = new ResumePosition(null)
    expect(resume.take(120_000)).toBeNull()
    resume.offer(60_000, true)
    expect(resume.take(120_000)).toBe(60_000)
    expect(resume.offer(10_000, true)).toBeNull()
    expect(resume.take(120_000)).toBeNull()
  })

  test('a user seek before the response cancels the saved position', () => {
    const resume = new ResumePosition(null)
    resume.userSeek()
    expect(resume.offer(60_000, true)).toBeNull()
    expect(resume.take(120_000)).toBeNull()
    expect(resume.current).toBe('ignored')
  })

  test('an explicit start outranks a user seek and a saved record', () => {
    const resume = new ResumePosition(null)
    resume.userSeek()
    resume.override(90_000)
    expect(resume.offer(60_000, true)).toBeNull()
    expect(resume.take(120_000)).toBe(90_000)
  })

  test('a saved position near the end is treated as finished', () => {
    const resume = new ResumePosition(null)
    resume.offer(115_000, true)
    expect(resume.take(120_000)).toBeNull()
    expect(resume.current).toBe('applied')
  })

  test('ignores short positions and records from another file version', () => {
    const short = new ResumePosition(null)
    expect(short.offer(4_000, true)).toBeNull()
    expect(short.current).toBe('ignored')

    const stale = new ResumePosition(null)
    expect(stale.offer(60_000, false)).toBeNull()
    expect(stale.current).toBe('ignored')
  })

  test('an explicit start is ready from the first render', () => {
    const resume = new ResumePosition(30_000)
    expect(resume.current).toBe('ready')
    expect(resume.take(120_000)).toBe(30_000)
  })
})
