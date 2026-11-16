import { describe, expect, test } from 'bun:test'
import { asFloats } from './vectors'

describe('asFloats', () => {
  test('an aligned blob of one vector is read as a view', () => {
    const bytes = new Uint8Array(16)
    new Float32Array(bytes.buffer).set([1, 2, 3, 4])

    const view = asFloats(bytes, 4)

    expect(view.buffer).toBe(bytes.buffer)
    expect([...view]).toEqual([1, 2, 3, 4])
  })

  test('a misaligned blob is copied before it is read', () => {
    const buffer = new ArrayBuffer(17)
    const source = new Float32Array([1, 2, 3, 4])
    new Uint8Array(buffer, 1, 16).set(new Uint8Array(source.buffer))

    const copy = asFloats(new Uint8Array(buffer, 1, 16), 4)

    expect(copy.buffer).not.toBe(buffer)
    expect([...copy]).toEqual([1, 2, 3, 4])
  })
})
