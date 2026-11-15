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
  test('emits a month header before each group', () => {
    const entries = buildGalleryEntries(
      [item('a', '2026-10-02T00:00:00Z'), item('b', '2026-09-02T00:00:00Z')],
      1_000,
      { gap: GAP, targetHeight: TARGET },
    )
    expect(entries[0]?.kind).toBe('header')
    expect(entries[1]?.kind).toBe('row')
    expect(entries[2]?.kind).toBe('header')
    expect(entries[3]?.kind).toBe('row')
    expect(entries.filter((entry) => entry.kind === 'header')).toHaveLength(2)
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
})
