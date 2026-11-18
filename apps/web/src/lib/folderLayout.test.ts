import { describe, expect, test } from 'bun:test'
import type { FolderDTO } from '@mediavault/shared'
import {
  buildFlatFolderMasonry,
  buildFolderMasonry,
  collectVisibleFolderNodes,
  folderColumnCount,
} from './folderLayout'

function makeFolder(
  id: string,
  width: number | null = 400,
  height: number | null = 300,
): FolderDTO {
  return {
    id,
    libraryId: 'lib1',
    parentId: null,
    name: `Folder ${id}`,
    relativePath: id,
    depth: 1,
    assetCount: 25,
    directImageCount: 25,
    coverAssetId: `asset-${id}`,
    coverWidth: width,
    coverHeight: height,
    coverPosterVersion: 1,
    coverFileVersion: 1,
    viewCount: 10,
    voteCount: 2,
    rate: 50,
    createdAt: '2026-11-18T00:00:00.000Z',
  }
}

describe('buildFolderMasonry', () => {
  test('returns empty layout when container width is non-positive or no folders exist', () => {
    expect(folderColumnCount(320)).toBe(2)
    expect(folderColumnCount(720)).toBe(3)
    expect(folderColumnCount(1000)).toBe(4)

    const unmeasured = buildFolderMasonry(
      [{ libraryId: 'lib1', libraryName: 'Main', folders: [makeFolder('f1')] }],
      0,
    )
    expect(unmeasured.totalHeight).toBe(0)
    expect(unmeasured.bandCount).toBe(0)
    expect(unmeasured.allNodes).toEqual([])
  })

  test('places first row left-to-right preserving sort order instead of column-first flow', () => {
    const folders = [makeFolder('0'), makeFolder('1'), makeFolder('2'), makeFolder('3')]
    const layout = buildFolderMasonry(
      [{ libraryId: 'lib1', libraryName: 'Sorted', folders }],
      1000,
    )
    const cards = layout.allNodes.filter((n) => n.kind === 'card')
    expect(cards).toHaveLength(4)
    expect(cards.map((c) => c.top)).toEqual([36, 36, 36, 36])
    for (let i = 1; i < cards.length; i += 1) {
      expect(cards[i]!.left).toBeGreaterThan(cards[i - 1]!.left)
    }
  })

  test('places subsequent cards into the shortest column', () => {
    const folders = [
      makeFolder('tall', 300, 600),
      makeFolder('short', 600, 300),
      makeFolder('medium-a', 400, 300),
      makeFolder('medium-b', 400, 300),
      makeFolder('next', 400, 300),
    ]
    const layout = buildFlatFolderMasonry(folders, 1000)
    const shortCard = layout.cards.find((c) => c.key === 'short')!
    const nextCard = layout.cards.find((c) => c.key === 'next')!
    expect(nextCard.left).toBe(shortCard.left)
    expect(nextCard.top).toBe(shortCard.top + shortCard.height + 12)
  })

  test('clamps extreme aspect ratios and stays strictly inside container bounds', () => {
    const folders = [
      makeFolder('ultra-wide', 5000, 100),
      makeFolder('ultra-tall', 100, 5000),
    ]
    const layout = buildFolderMasonry(
      [{ libraryId: 'lib1', libraryName: 'Extremes', folders }],
      800,
    )
    const cards = layout.allNodes.filter((n) => n.kind === 'card')
    for (const card of cards) {
      expect(card.left + card.width).toBeLessThanOrEqual(800)
      expect(card.imageHeight).toBeGreaterThanOrEqual(60)
      expect(card.imageHeight).toBeLessThanOrEqual(Math.round(card.width / 0.45) + 1)
    }
  })

  test('deduplicates tall cards across bands and bounds mounted DOM count on large lists', () => {
    const folders = Array.from({ length: 1000 }, (_, i) =>
      makeFolder(`f-${i}`, i % 3 === 0 ? 300 : 600, i % 3 === 0 ? 600 : 400),
    )
    const layout = buildFolderMasonry(
      [{ libraryId: 'lib1', libraryName: 'Thousand', folders }],
      1000,
    )
    const midBand = Math.floor(layout.bandCount / 2)
    const windowBands = [midBand - 1, midBand, midBand + 1]
    const visible = collectVisibleFolderNodes(layout, windowBands)
    const keys = visible.map((n) => n.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(visible.length).toBeLessThan(30)
  })
})
