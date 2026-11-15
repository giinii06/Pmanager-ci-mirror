import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { assertAssetId, cacheRelativePath, resolveInside, thumbnailPath } from './paths'

const root = path.resolve('/srv/media')

describe('resolveInside', () => {
  test('resolves normal relative paths', () => {
    expect(resolveInside(root, 'Photos/2026/a.jpg')).toBe(path.join(root, 'Photos/2026/a.jpg'))
    expect(resolveInside(root, 'a.jpg')).toBe(path.join(root, 'a.jpg'))
  })

  test('allows the root itself', () => {
    expect(resolveInside(root, '.')).toBe(root)
  })

  test('rejects escapes and absolute paths', () => {
    expect(resolveInside(root, '../etc/passwd')).toBeNull()
    expect(resolveInside(root, 'Photos/../../etc/passwd')).toBeNull()
    expect(resolveInside(root, '/etc/passwd')).toBeNull()
    expect(resolveInside(root, 'Photos/..')).toBe(root)
    expect(resolveInside(root, 'a\0b')).toBeNull()
  })
})

describe('cache paths', () => {
  test('thumbnails are versioned per asset', () => {
    expect(thumbnailPath('/cache', 'abc123', 2, 320)).toBe('/cache/thumbs/abc123/v2/320.webp')
  })

  test('rejects unsafe asset ids', () => {
    expect(() => assertAssetId('../x')).toThrow()
    expect(() => assertAssetId('ABC123')).toThrow()
    expect(() => thumbnailPath('/cache', 'a/b', 1, 320)).toThrow()
  })

  test('cacheRelativePath always uses forward slashes', () => {
    expect(cacheRelativePath('/cache', '/cache/thumbs/a/v1/320.webp')).toBe('thumbs/a/v1/320.webp')
  })
})
