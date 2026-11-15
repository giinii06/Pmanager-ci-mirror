import type { Priority } from './domain'

export const THUMBNAIL_SIZES = [320, 640] as const
export type ThumbnailSize = (typeof THUMBNAIL_SIZES)[number]

export const THUMBNAIL_QUALITY = 78
export const PREVIEW_SIZE = 1600
export const PREVIEW_QUALITY = 82

export const DEFAULT_PAGE_SIZE = 60
export const MAX_PAGE_SIZE = 200

export const PRIORITY = {
  now: 0,
  visible: 1,
  next: 2,
  backlog: 3,
  optional: 4,
} as const satisfies Record<string, Priority>

export const GALLERY_TARGET_ROW_HEIGHT = 224
export const GALLERY_GAP = 4

export const MAX_THUMBNAIL_RETRIES = 8

export function isThumbnailSize(value: number): value is ThumbnailSize {
  return value === 320 || value === 640
}
