import { describe, expect, test } from 'bun:test'
import { StartPosition } from './start-position'

describe('StartPosition', () => {
  test('normal opens always start at zero, including after previously watched videos', () => {
    const firstOpen = new StartPosition(null)
    expect(firstOpen.current).toBe('ignored')
    expect(firstOpen.take(120_000)).toBeNull()
    const nextOpen = new StartPosition(null)
    expect(nextOpen.take(120_000)).toBeNull()
    expect(new StartPosition(0).take(120_000)).toBeNull()
  })

  test('explicit search or bookmark timestamp applies once after metadata loads', () => {
    const position = new StartPosition(45_000)
    expect(position.take(Number.NaN)).toBeNull()
    expect(position.current).toBe('ready')
    expect(position.take(120_000)).toBe(45_000)
    expect(position.current).toBe('applied')
    expect(position.take(120_000)).toBeNull()
  })

  test('a manual seek before metadata cancels an explicit timestamp', () => {
    const position = new StartPosition(45_000)
    position.userSeek()
    expect(position.take(120_000)).toBeNull()
  })

  test('another explicit timestamp can override a previous decision', () => {
    const position = new StartPosition(null)
    position.override(60_000)
    expect(position.take(120_000)).toBe(60_000)
    position.override(30_000)
    expect(position.take(120_000)).toBe(30_000)
  })

  test('invalid timestamps and timestamps near the end do not seek', () => {
    expect(new StartPosition(-2_000).take(120_000)).toBeNull()
    expect(new StartPosition(Number.POSITIVE_INFINITY).take(120_000)).toBeNull()
    expect(new StartPosition(115_000).take(120_000)).toBeNull()
  })
})
