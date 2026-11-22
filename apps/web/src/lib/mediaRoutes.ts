import type { AssetKind } from '@mediavault/shared'

/** Opaque-ID route, never derived from filenames or filesystem paths. */
export function assetUrl(kind: AssetKind, id: string): string {
  return `/${kind === 'video' ? 'videos' : 'photos'}/${encodeURIComponent(id)}`
}

export function isMediaPath(pathname: string): boolean {
  const parts = pathname.split('/')
  return parts.length === 3 && (parts[1] === 'videos' || parts[1] === 'photos') && Boolean(parts[2])
}
