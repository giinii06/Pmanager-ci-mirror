import { describe, expect, test } from 'bun:test'
import { GALLERY_VIDEO_TARGET_ROW_HEIGHT, type TagSummaryDTO } from '@mediavault/shared'
import { buildVideoTagRows } from './videoTagLayout'

function tag(id: string, width: number | null, height: number | null): TagSummaryDTO {
  return {
    id,
    name: `Tag ${id}`,
    assetCount: 3,
    coverAssetId: `cover-${id}`,
    coverPosterVersion: 1,
    coverWidth: width,
    coverHeight: height,
    createdAt: '2026-11-22T00:00:00Z',
  }
}

describe('video tag overview layout', () => {
  test('packs mixed portrait and landscape covers into full justified rows', () => {
    const tags = [
      tag('portrait', 720, 1280),
      tag('wide', 1920, 1080),
      tag('square', 1080, 1080),
      tag('panorama', 2560, 1080),
      tag('classic', 1600, 1200),
      tag('wide-2', 1920, 1080),
      tag('square-2', 1080, 1080),
      tag('portrait-2', 720, 1280),
    ]
    const rows = buildVideoTagRows(tags, 1100)
    const placed = rows.flatMap((row) => row.items)
    expect(placed.map((item) => item.item.id)).toEqual(tags.map((item) => item.id))
    expect(rows.length).toBeGreaterThan(1)
    for (const entry of placed) {
      const expectedRatio = entry.item.coverWidth! / entry.item.coverHeight!
      expect(entry.width / entry.height).toBeCloseTo(expectedRatio, 2)
    }
    for (const row of rows.slice(0, -1)) {
      const total = row.items.reduce((sum, item) => sum + item.width, 0) + (row.items.length - 1) * 8
      expect(total).toBeCloseTo(1100, 0)
    }
  })

  test('handles empty/unmeasured layouts, missing dimensions and narrow screens', () => {
    expect(buildVideoTagRows([], 1080)).toEqual([])
    expect(buildVideoTagRows([tag('missing', null, null)], 0)).toEqual([])
    const tags = [tag('missing', null, null), tag('bad', -4, 0), tag('portrait', 720, 1280)]
    const rows = buildVideoTagRows(tags, 280)
    const placed = rows.flatMap((row) => row.items)
    expect(placed).toHaveLength(tags.length)
    for (const row of rows) {
      const total = row.items.reduce((sum, item) => sum + item.width, 0) + (row.items.length - 1) * 8
      expect(total).toBeLessThanOrEqual(280.01)
    }
    for (const tile of placed) {
      expect(tile.width).toBeGreaterThan(0)
      expect(tile.height).toBeGreaterThan(0)
    }
  })

  test('keeps a single last cover at gallery target height rather than stretching', () => {
    const rows = buildVideoTagRows([tag('solo', 720, 1280)], 1100)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.items[0]!.height).toBe(GALLERY_VIDEO_TARGET_ROW_HEIGHT)
    expect(rows[0]!.items[0]!.width).toBeCloseTo((720 / 1280) * GALLERY_VIDEO_TARGET_ROW_HEIGHT, 1)
  })
})
