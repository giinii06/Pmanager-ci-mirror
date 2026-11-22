import { describe, expect, test } from 'bun:test'
import { posterPositionMs } from './posterFrame'

describe('immediate poster capture position', () => {
  test('captures the exact current video frame in milliseconds', () => {
    expect(posterPositionMs(12.345, 60)).toBe(12_345)
    expect(posterPositionMs(0, 60)).toBe(0)
  })

  test('does not request a nonexistent frame beyond the video end', () => {
    expect(posterPositionMs(60, 60)).toBe(59_500)
    expect(posterPositionMs(3, 0.2)).toBe(0)
  })

  test('rejects unusable player time or duration', () => {
    expect(posterPositionMs(Number.NaN, 60)).toBeNull()
    expect(posterPositionMs(-1, 60)).toBeNull()
    expect(posterPositionMs(0, Number.POSITIVE_INFINITY)).toBeNull()
    expect(posterPositionMs(0, 0)).toBeNull()
  })
})
