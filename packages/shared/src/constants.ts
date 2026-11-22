import type { Priority } from './domain'

/**
 * The release version, reported by `GET /api/health` and the diagnostics app
 * section. It must equal the root `package.json` version, which
 * `bun run release:check` asserts.
 */
export const APP_VERSION = '1.0.0'

export const THUMBNAIL_SIZES = [320, 640] as const
export type ThumbnailSize = (typeof THUMBNAIL_SIZES)[number]

export const THUMBNAIL_QUALITY = 78
export const PREVIEW_SIZE = 1600
export const PREVIEW_QUALITY = 82

/**
 * Part of the poster cache path and the thumbnail URL, so bump it whenever the
 * poster extraction rule changes. A poster that already exists is skipped, and
 * browsers keep one for a year, so a rule change alone rebuilds nothing.
 */
export const POSTER_SCHEME = 2

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
export const GALLERY_VIDEO_TARGET_ROW_HEIGHT = 640
export const GALLERY_GAP = 4

export const MAX_THUMBNAIL_RETRIES = 8

export function isThumbnailSize(value: number): value is ThumbnailSize {
  return value === 320 || value === 640
}
