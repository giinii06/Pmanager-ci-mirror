import { expect, test } from 'bun:test'
import { assetUrl, isMediaPath } from './mediaRoutes'

test('media URL routing uses opaque IDs', () => {
  expect(assetUrl('video', 'abc-123')).toBe('/videos/abc-123')
  expect(assetUrl('image', 'asset 123')).toBe('/photos/asset%20123')
  expect(isMediaPath('/photos/abc-123')).toBe(true)
  expect(isMediaPath('/videos/abc-123')).toBe(true)
  expect(isMediaPath('/videos/tags/abc')).toBe(false)
  expect(isMediaPath('/journal')).toBe(false)
})
