/**
 * Page grouping for the image viewer. The viewer stores the selected asset,
 * not the page, so this module turns that asset list into half-open pages
 * whenever the stage size changes.
 */

/** Space between the two images of a paired page, in CSS pixels. */
export const VIEWER_GAP = 16

export interface ViewerItem {
  kind: 'image' | 'video'
  width: number | null
  height: number | null
}

/** Half-open range of item indices: [start, end). */
export interface ViewerPage {
  start: number
  end: number
}

export interface ViewerRoom {
  width: number
  height: number
}

export interface SlotSize {
  width: number
  height: number
}

function ratio(item: ViewerItem): number {
  const width = item.width ?? 0
  const height = item.height ?? 0
  if (width <= 0 || height <= 0) return 0
  return width / height
}

function isPortrait(item: ViewerItem | undefined): item is ViewerItem {
  return Boolean(
    item &&
      item.kind === 'image' &&
      item.width &&
      item.height &&
      item.width > 0 &&
      item.height > item.width,
  )
}

/** Two portraits share a page only while both still fit at the stage height. */
function fitsPair(first: ViewerItem, second: ViewerItem, room: ViewerRoom, gap: number): boolean {
  if (room.width <= 0 || room.height <= 0) return false
  const firstRatio = ratio(first)
  const secondRatio = ratio(second)
  if (firstRatio <= 0 || secondRatio <= 0) return false
  return room.height * (firstRatio + secondRatio) + gap <= room.width
}

/**
 * Groups neighbouring portrait images into pages. Grouping runs from the
 * first item, so the page a photo belongs to never depends on which photo is
 * selected. Everything else — videos, landscapes, unknown dimensions — gets a
 * page of its own.
 */
export function groupViewerItems(
  items: ViewerItem[],
  room: ViewerRoom,
  gap = VIEWER_GAP,
): ViewerPage[] {
  const pages: ViewerPage[] = []
  let index = 0

  while (index < items.length) {
    const first = items[index]
    const second = items[index + 1]
    if (
      isPortrait(first) &&
      isPortrait(second) &&
      fitsPair(first, second, room, gap)
    ) {
      pages.push({ start: index, end: index + 2 })
      index += 2
      continue
    }
    pages.push({ start: index, end: index + 1 })
    index += 1
  }

  return pages
}

/** The page holding `index`, clamped to the last page for a stale index. */
export function pageAt(pages: ViewerPage[], index: number): number {
  for (let page = 0; page < pages.length; page += 1) {
    const range = pages[page]
    if (range && index >= range.start && index < range.end) return page
  }
  return Math.max(0, pages.length - 1)
}

/**
 * Fits every item of a page into the stage. A single image fills whichever
 * axis runs out first; a pair shares one height so both keep their ratios.
 */
export function fitPage(
  items: ViewerItem[],
  page: ViewerPage,
  room: ViewerRoom,
  gap = VIEWER_GAP,
): SlotSize[] {
  const width = Math.max(0, room.width)
  const height = Math.max(0, room.height)
  const slots = items.slice(page.start, page.end)
  if (width <= 0 || height <= 0 || slots.length === 0) return []

  const ratios = slots.map((item) => {
    const value = ratio(item)
    return value > 0 ? value : 1
  })
  const total = ratios.reduce((sum, value) => sum + value, 0)
  const gaps = gap * (slots.length - 1)
  const fitted = Math.max(0, Math.min(height, (width - gaps) / total))

  return ratios.map((value) => ({
    width: Math.max(1, Math.round(fitted * value)),
    height: Math.max(1, Math.round(fitted)),
  }))
}
