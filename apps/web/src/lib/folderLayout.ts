import type { FolderDTO } from '@mediavault/shared'

export interface FolderSectionInput {
  libraryId: string
  libraryName: string
  folders: FolderDTO[]
}

export interface PlacedFolderCard {
  kind: 'card'
  key: string
  folder: FolderDTO
  index: number
  left: number
  top: number
  width: number
  imageHeight: number
  height: number
}

export interface PlacedFolderHeader {
  kind: 'header'
  key: string
  libraryId: string
  libraryName: string
  folderCount: number
  top: number
  height: number
}

export type PlacedFolderNode = PlacedFolderHeader | PlacedFolderCard

export interface FolderMasonryLayout {
  columns: number
  totalHeight: number
  bandHeight: number
  bandCount: number
  nodesByBand: PlacedFolderNode[][]
  allNodes: PlacedFolderNode[]
}

export const FOLDER_HEADER_HEIGHT = 28

const CARD_BORDER_HEIGHT = 2
const HEADER_BOTTOM_GAP = 8
const SECTION_BOTTOM_GAP = 32
const MIN_IMAGE_HEIGHT = 60
const DEFAULT_GAP = 12
const DEFAULT_BAND_HEIGHT = 360

export function folderColumnCount(width: number): number {
  if (width < 600) return 2
  if (width < 960) return 3
  return 4
}

export function clampedCoverAspectRatio(width: number | null, height: number | null): number {
  const safeW = width && width > 0 ? width : 4
  const safeH = height && height > 0 ? height : 3
  return Math.min(2.4, Math.max(0.45, safeW / safeH))
}

function columnWidthFor(containerWidth: number, columns: number, gap: number): number {
  return Math.max(1, Math.floor(((containerWidth - gap * (columns - 1)) / columns) * 100) / 100)
}

function packFolderColumns(
  folders: readonly FolderDTO[],
  columns: number,
  colWidth: number,
  gap: number,
  startTop: number,
  startIndex: number,
): { cards: PlacedFolderCard[]; bottom: number } {
  const colBottoms = new Array<number>(columns).fill(startTop)
  const cards: PlacedFolderCard[] = []

  for (let i = 0; i < folders.length; i += 1) {
    const folder = folders[i]!
    const ratio = clampedCoverAspectRatio(folder.coverWidth, folder.coverHeight)
    const imageHeight = Math.max(MIN_IMAGE_HEIGHT, Math.round(colWidth / ratio))
    const height = imageHeight + CARD_BORDER_HEIGHT

    let targetCol = 0
    for (let col = 1; col < columns; col += 1) {
      if (colBottoms[col]! < colBottoms[targetCol]!) targetCol = col
    }

    const left = Math.round(targetCol * (colWidth + gap) * 100) / 100
    const top = colBottoms[targetCol]!
    colBottoms[targetCol] = top + height + gap

    cards.push({
      kind: 'card',
      key: folder.id,
      folder,
      index: startIndex + i,
      left,
      top,
      width: colWidth,
      imageHeight,
      height,
    })
  }

  return { cards, bottom: Math.max(...colBottoms) - gap }
}

export function buildFlatFolderMasonry(
  folders: readonly FolderDTO[],
  containerWidth: number,
  gap = DEFAULT_GAP,
): { columns: number; totalHeight: number; cards: PlacedFolderCard[] } {
  const columns = folderColumnCount(Math.max(0, containerWidth))
  if (containerWidth <= 0 || folders.length === 0) {
    return { columns, totalHeight: 0, cards: [] }
  }
  const colWidth = columnWidthFor(containerWidth, columns, gap)
  const { cards, bottom } = packFolderColumns(folders, columns, colWidth, gap, 0, 0)
  return { columns, totalHeight: Math.max(0, bottom), cards }
}

export function buildFolderMasonry(
  sections: readonly FolderSectionInput[],
  containerWidth: number,
  options: { gap?: number; bandHeight?: number } = {},
): FolderMasonryLayout {
  const gap = options.gap ?? DEFAULT_GAP
  const bandHeight = options.bandHeight ?? DEFAULT_BAND_HEIGHT
  const columns = folderColumnCount(Math.max(0, containerWidth))

  const nonEmpty = sections.filter((section) => section.folders.length > 0)
  if (containerWidth <= 0 || nonEmpty.length === 0) {
    return { columns, totalHeight: 0, bandHeight, bandCount: 0, nodesByBand: [], allNodes: [] }
  }

  const colWidth = columnWidthFor(containerWidth, columns, gap)
  const allNodes: PlacedFolderNode[] = []
  let cursorY = 0
  let cardIndex = 0

  for (let sectionIdx = 0; sectionIdx < nonEmpty.length; sectionIdx += 1) {
    const section = nonEmpty[sectionIdx]!
    allNodes.push({
      kind: 'header',
      key: `header-${section.libraryId}`,
      libraryId: section.libraryId,
      libraryName: section.libraryName,
      folderCount: section.folders.length,
      top: cursorY,
      height: FOLDER_HEADER_HEIGHT,
    })
    cursorY += FOLDER_HEADER_HEIGHT + HEADER_BOTTOM_GAP

    const packed = packFolderColumns(section.folders, columns, colWidth, gap, cursorY, cardIndex)
    allNodes.push(...packed.cards)
    cardIndex += section.folders.length
    cursorY = sectionIdx < nonEmpty.length - 1 ? packed.bottom + SECTION_BOTTOM_GAP : packed.bottom
  }

  const totalHeight = Math.max(0, cursorY)
  const bandCount = Math.max(1, Math.ceil(totalHeight / bandHeight))
  const nodesByBand: PlacedFolderNode[][] = Array.from({ length: bandCount }, () => [])

  for (const node of allNodes) {
    const startBand = Math.max(0, Math.floor(node.top / bandHeight))
    const endBand = Math.min(
      bandCount - 1,
      Math.max(startBand, Math.floor(Math.max(node.top, node.top + node.height - 1) / bandHeight)),
    )
    for (let b = startBand; b <= endBand; b += 1) {
      nodesByBand[b]!.push(node)
    }
  }

  return { columns, totalHeight, bandHeight, bandCount, nodesByBand, allNodes }
}

export function collectVisibleFolderNodes(
  layout: FolderMasonryLayout,
  bandIndices: readonly number[],
): PlacedFolderNode[] {
  if (layout.bandCount === 0 || bandIndices.length === 0) return []
  const seen = new Set<string>()
  const visible: PlacedFolderNode[] = []
  for (const bandIndex of bandIndices) {
    const band = layout.nodesByBand[bandIndex]
    if (!band) continue
    for (const node of band) {
      if (seen.has(node.key)) continue
      seen.add(node.key)
      visible.push(node)
    }
  }
  return visible
}
