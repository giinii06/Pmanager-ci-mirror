import { describe, expect, test } from 'bun:test'
import { buildGalleryEntries, type GalleryEntry, type GalleryItem } from './justified'

const GAP = 4
const TARGET = 224

function item(id: string, takenAt: string, width = 1_600, height = 1_067): GalleryItem {
  return { id, takenAt, width, height }
}

function rowWidth(entry: GalleryEntry<GalleryItem>): number {
  if (entry.kind !== 'row') return 0
  return entry.items.reduce((total, placed) => total + placed.width, 0) + GAP * (entry.items.length - 1)
}

describe('buildGalleryEntries', () => {
  test('omits month headers by default and emits them only when groupByMonth is true', () => {
    const defaultEntries = buildGalleryEntries(
      [item('a', '2026-10-02T00:00:00Z'), item('b', '2026-09-02T00:00:00Z')],
      1_000,
      { gap: GAP, targetHeight: TARGET },
    )
    expect(defaultEntries.some((entry) => entry.kind === 'header')).toBe(false)

    const entries = buildGalleryEntries(
      [item('a', '2026-10-02T00:00:00Z'), item('b', '2026-09-02T00:00:00Z')],
      1_000,
      { gap: GAP, targetHeight: TARGET, groupByMonth: true },
    )
    expect(entries[0]?.kind).toBe('header')
    expect(entries[1]?.kind).toBe('row')
    expect(entries[2]?.kind).toBe('header')
    expect(entries[3]?.kind).toBe('row')
    expect(entries.filter((entry) => entry.kind === 'header')).toHaveLength(2)
  })

  test('preserves true aspect ratio across 21:9, 16:9, 4:3, 1:1, and 9:16 tiles without stretching', () => {
    const mixed = [
      item('ultra', '2026-10-02T00:00:00Z', 2560, 1080),
      item('hd', '2026-10-02T00:00:00Z', 1920, 1080),
      item('classic', '2026-10-02T00:00:00Z', 1600, 1200),
      item('square', '2026-10-02T00:00:00Z', 1000, 1000),
      item('portrait', '2026-10-02T00:00:00Z', 1080, 1920),
    ]
    const entries = buildGalleryEntries(mixed, 980, { gap: 3, targetHeight: TARGET })
    const placed = entries.flatMap((entry) => (entry.kind === 'row' ? entry.items : []))
    expect(placed).toHaveLength(5)
    for (const tile of placed) {
      const expectedRatio = (tile.item.width ?? 1) / (tile.item.height ?? 1)
      const actualRatio = tile.width / tile.height
      expect(Math.abs(actualRatio - expectedRatio) / expectedRatio).toBeLessThanOrEqual(0.02)
    }
  })

  test('full rows fill the container exactly', () => {
    const items = Array.from({ length: 9 }, (_, index) =>
      item(`a${index}`, '2026-10-02T00:00:00Z'),
    )
    const entries = buildGalleryEntries(items, 1_000, { gap: GAP, targetHeight: TARGET })
    const rows = entries.filter((entry) => entry.kind === 'row')

    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      if (row.kind !== 'row') continue
      const height = row.height - GAP
      if (height < TARGET - 0.01) {
        expect(rowWidth(row)).toBeCloseTo(1_000, 0)
      }
    }
  })

  test('a partial last row keeps the target height instead of stretching', () => {
    const entries = buildGalleryEntries([item('solo', '2026-10-02T00:00:00Z')], 1_000, {
      gap: GAP,
      targetHeight: TARGET,
    })
    const row = entries.find((entry) => entry.kind === 'row')
    expect(row?.kind).toBe('row')
    if (row?.kind !== 'row') return
    expect(row.height).toBe(TARGET + GAP)
    expect(rowWidth(row)).toBeCloseTo(1.5 * TARGET, 0)
  })

  test('portrait and panorama ratios stay inside their row', () => {
    const items = [
      item('p', '2026-10-02T00:00:00Z', 720, 1_280),
      item('l', '2026-10-02T00:00:00Z', 1_920, 1_080),
      item('x', '2026-10-02T00:00:00Z', 6_000, 1_000),
      item('t', '2026-10-02T00:00:00Z', 1_000, 1_000),
    ]
    const entries = buildGalleryEntries(items, 1_000, { gap: GAP, targetHeight: TARGET })
    const placed = entries.flatMap((entry) => (entry.kind === 'row' ? entry.items : []))
    expect(placed).toHaveLength(4)
    for (const tile of placed) {
      expect(tile.width).toBeGreaterThan(1)
      expect(tile.height).toBeGreaterThanOrEqual(80)
    }
  })

  test('can pack rows without month headers for folder views', () => {
    const items = [
      item('a', '2026-10-02T00:00:00Z'),
      item('b', '2026-09-02T00:00:00Z'),
      item('c', '2026-08-02T00:00:00Z'),
    ]
    const entries = buildGalleryEntries(items, 1_000, {
      gap: GAP,
      targetHeight: TARGET,
      groupByMonth: false,
    })
    expect(entries.every((entry) => entry.kind === 'row')).toBe(true)
    expect(entries.flatMap((entry) => (entry.kind === 'row' ? entry.items : []))).toHaveLength(3)
  })

  test('returns nothing for an unmeasured container', () => {
    expect(buildGalleryEntries([item('a', '2026-10-02T00:00:00Z')], 0)).toEqual([])
  })

  test('does not overflow ultra-narrow containers on wide panorama tiles', () => {
    const entries = buildGalleryEntries(
      [item('wide', '2026-10-02T00:00:00Z', 4_000, 1_000)],
      280,
      { gap: GAP, targetHeight: TARGET, groupByMonth: false },
    )
    const placed = entries.flatMap((entry) => (entry.kind === 'row' ? entry.items : []))
    expect(placed).toHaveLength(1)
    expect(placed[0]!.width).toBeLessThanOrEqual(280)
  })
})
