import { describe, expect, test } from 'bun:test'
import { selectAlbumNeighbor, selectRandomAlbum } from './albumNavigation'

describe('album browsing', () => {
  test('wraps in both directions without duplicate visits', () => {
    expect(selectAlbumNeighbor(['a', 'b', 'c'], 'a', 'prev')).toBe('c')
    expect(selectAlbumNeighbor(['a', 'b', 'c'], 'c', 'next')).toBe('a')
    expect(selectAlbumNeighbor(['a', 'a', 'b'], 'a', 'next')).toBe('b')
  })
  test('no navigation for unknown, empty or single item albums', () => {
    expect(selectAlbumNeighbor(['a'], 'a', 'next')).toBeNull()
    expect(selectAlbumNeighbor(['a', 'b'], 'unknown', 'next')).toBeNull()
    expect(selectRandomAlbum(['a'], 'a')).toBeNull()
  })
  test('shuffle excludes current album', () => {
    expect(selectRandomAlbum(['a', 'b', 'c'], 'a', () => 0)).toBe('b')
    expect(selectRandomAlbum(['a', 'b', 'c'], 'a', () => 0.999)).toBe('c')
  })
})
