import { GALLERY_GAP, GALLERY_TARGET_ROW_HEIGHT } from '@mediavault/shared'
import { aspectRatio } from './format'

export interface GalleryItem {
  id: string
  takenAt: string
  width: number | null
  height: number | null
}

export interface PlacedItem<T> {
  item: T
  index: number
  width: number
  height: number
}

export type GalleryEntry<T> =
  | { kind: 'header'; key: string; label: string; height: number }
  | { kind: 'row'; key: string; height: number; items: Array<PlacedItem<T>> }

export interface LayoutOptions {
  gap?: number
  targetHeight?: number
  headerHeight?: number
  groupByMonth?: boolean
}

function monthKey(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'unknown'
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function monthLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '날짜 없음'
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long' }).format(date)
}

/**
 * Packs items into rows whose heights are equal and whose widths fill the
 * container. The last row of each month keeps the target height so a partial
 * row does not stretch into huge tiles.
 */
export function buildGalleryEntries<T extends GalleryItem>(
  items: T[],
  containerWidth: number,
  options: LayoutOptions = {},
): Array<GalleryEntry<T>> {
  const gap = options.gap ?? GALLERY_GAP
  const target = options.targetHeight ?? GALLERY_TARGET_ROW_HEIGHT
  const headerHeight = options.headerHeight ?? 52
  const width = Math.floor(containerWidth)
  if (width <= 0) return []

  const entries: Array<GalleryEntry<T>> = []
  let row: T[] = []
  let ratios: number[] = []
  let rowStart = 0
  let month = ''

  const flush = (full: boolean): void => {
    if (row.length === 0) return
    const gaps = gap * (row.length - 1)
    const sum = ratios.reduce((total, ratio) => total + ratio, 0)
    if (sum <= 0) {
      row = []
      ratios = []
      return
    }

    let height = (width - gaps) / sum
    const clampedDown = height > target * 1.6
    const clampedUp = height < 80
    height = Math.min(height, target * 1.6)
    if (!full) height = Math.min(height, target)
    height = Math.max(80, height)

    const placed: Array<PlacedItem<T>> = []
    let used = 0
    for (let index = 0; index < row.length; index += 1) {
      const item = row[index]
      const ratio = ratios[index]
      if (!item || ratio === undefined) continue
      const isLast = index === row.length - 1
      const canSnapFullWidth = full && isLast && !clampedDown && !clampedUp
      const naturalWidth = Math.round(ratio * height * 100) / 100
      const remainderWidth = Math.max(1, width - used - gap * (row.length - 1 - index))
      const itemWidth =
        canSnapFullWidth && Math.abs(remainderWidth - naturalWidth) <= 3
          ? remainderWidth
          : naturalWidth
      placed.push({ item, index: rowStart + index, width: itemWidth, height })
      used += itemWidth + gap
    }

    entries.push({
      kind: 'row',
      key: `row-${row[0]?.id ?? placed[0]?.item.id ?? entries.length}`,
      height: height + gap,
      items: placed,
    })
    row = []
    ratios = []
  }

  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex]
    if (!item) continue
    if (options.groupByMonth === true) {
      const key = monthKey(item.takenAt)
      if (key !== month) {
        flush(false)
        month = key
        entries.push({
          kind: 'header',
          key: `header-${key}`,
          label: monthLabel(item.takenAt),
          height: headerHeight,
        })
      }
    }

    if (row.length === 0) rowStart = itemIndex
    row.push(item)
    ratios.push(aspectRatio(item.width, item.height))
    const gaps = gap * (row.length - 1)
    const sum = ratios.reduce((total, ratio) => total + ratio, 0)
    if (sum * target + gaps >= width) flush(true)
  }
  flush(false)

  return entries
}
