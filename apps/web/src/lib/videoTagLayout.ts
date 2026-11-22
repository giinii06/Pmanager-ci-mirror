import type { TagSummaryDTO } from '@mediavault/shared'
import { buildGalleryEntries, type GalleryEntry } from './justified'

export type VideoTagLayoutItem = TagSummaryDTO & {
  width: number | null
  height: number | null
  takenAt: string
}
export type VideoTagRow = Extract<GalleryEntry<VideoTagLayoutItem>, { kind: 'row' }>

/** Share the standard video gallery's aspect-preserving row packing. */
export function buildVideoTagRows(
  tags: readonly TagSummaryDTO[],
  containerWidth: number,
): VideoTagRow[] {
  const covers: VideoTagLayoutItem[] = tags.map((tag) => ({
    ...tag,
    width: tag.coverWidth,
    height: tag.coverHeight,
    takenAt: tag.createdAt,
  }))
  return buildGalleryEntries(covers, containerWidth, { gap: 8, targetHeight: 320 }).filter(
    (entry): entry is VideoTagRow => entry.kind === 'row',
  )
}
