import { describe, expect, test } from 'bun:test'
import {
  fitPage,
  groupViewerItems,
  pageAt,
  VIEWER_GAP,
  type ViewerItem,
  type ViewerRoom,
} from './viewerPages'

function portrait(width = 720, height = 1_280): ViewerItem {
  return { kind: 'image', width, height }
}

function landscape(width = 1_600, height = 900): ViewerItem {
  return { kind: 'image', width, height }
}

function video(): ViewerItem {
  return { kind: 'video', width: 1_920, height: 1_080 }
}

const WIDE: ViewerRoom = { width: 1_200, height: 700 }
const NARROW: ViewerRoom = { width: 600, height: 700 }

describe('groupViewerItems', () => {
  test('pairs two portraits when the stage has room', () => {
    expect(groupViewerItems([portrait(), portrait()], WIDE)).toEqual([{ start: 0, end: 2 }])
  })

  test('keeps portraits apart when the stage is too narrow', () => {
    expect(groupViewerItems([portrait(), portrait()], NARROW)).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ])
  })

  test('never pairs a landscape or a video', () => {
    expect(groupViewerItems([portrait(), landscape()], WIDE)).toHaveLength(2)
    expect(groupViewerItems([landscape(), portrait()], WIDE)).toHaveLength(2)
    expect(groupViewerItems([portrait(), video()], WIDE)).toHaveLength(2)
    expect(groupViewerItems([landscape(), landscape()], WIDE)).toHaveLength(2)
  })

  test('does not pair across a video', () => {
    const pages = groupViewerItems([portrait(), video(), portrait()], WIDE)
    expect(pages).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ])
  })

  test('groups three portraits greedily from the first item', () => {
    expect(groupViewerItems([portrait(), portrait(), portrait()], WIDE)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 3 },
    ])
  })

  test('treats unknown dimensions as single pages', () => {
    const unknown: ViewerItem = { kind: 'image', width: null, height: null }
    expect(groupViewerItems([unknown, unknown], WIDE)).toHaveLength(2)
  })

  test('splits everything before the stage is measured', () => {
    const pages = groupViewerItems([portrait(), portrait()], { width: 0, height: 0 })
    expect(pages).toHaveLength(2)
  })

  test('leaves an empty list empty', () => {
    expect(groupViewerItems([], WIDE)).toEqual([])
  })
})

describe('pageAt', () => {
  const pages = [
    { start: 0, end: 2 },
    { start: 2, end: 3 },
    { start: 3, end: 5 },
  ]

  test('finds the page holding the selection', () => {
    expect(pageAt(pages, 0)).toBe(0)
    expect(pageAt(pages, 1)).toBe(0)
    expect(pageAt(pages, 2)).toBe(1)
    expect(pageAt(pages, 4)).toBe(2)
  })

  test('clamps a stale index to the last page', () => {
    expect(pageAt(pages, 99)).toBe(2)
    expect(pageAt([], 3)).toBe(0)
  })
})

describe('fitPage', () => {
  test('a landscape fills the width first', () => {
    const [slot] = fitPage([landscape()], { start: 0, end: 1 }, { width: 1_000, height: 700 })
    expect(slot?.width).toBe(1_000)
    expect(slot?.height).toBe(563)
  })

  test('a portrait fills the height first', () => {
    const [slot] = fitPage([portrait()], { start: 0, end: 1 }, { width: 1_000, height: 700 })
    expect(slot?.height).toBe(700)
    expect(slot?.width).toBe(394)
  })

  test('a pair shares one height and leaves the gap between', () => {
    const slots = fitPage([portrait(), portrait()], { start: 0, end: 2 }, WIDE)
    expect(slots).toHaveLength(2)
    expect(slots[0]?.height).toBe(700)
    expect(slots[1]?.height).toBe(700)
    const used = (slots[0]?.width ?? 0) + (slots[1]?.width ?? 0) + VIEWER_GAP
    expect(used).toBeLessThanOrEqual(WIDE.width)
  })

  test('returns nothing before the stage is measured', () => {
    expect(fitPage([portrait()], { start: 0, end: 1 }, { width: 0, height: 0 })).toEqual([])
  })
})
