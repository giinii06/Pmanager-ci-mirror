import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { POSTER_SCHEME } from '@mediavault/shared'

const ASSET_ID = /^[a-z0-9]{6,32}$/

export function assertAssetId(assetId: string): string {
  if (!ASSET_ID.test(assetId)) throw new Error(`invalid asset id: ${assetId}`)
  return assetId
}

/**
 * Resolves a relative path under a root and refuses anything that escapes it.
 * Absolute inputs are rejected so a caller cannot bypass the root.
 */
export function resolveInside(root: string, relative: string): string | null {
  if (relative.includes('\0')) return null
  if (path.isAbsolute(relative)) return null
  const base = path.resolve(root)
  const target = path.resolve(base, relative)
  if (target === base) return target
  return target.startsWith(base + path.sep) ? target : null
}

export function thumbnailPath(
  cacheDir: string,
  assetId: string,
  version: number,
  size: number,
): string {
  return path.join(cacheDir, 'thumbs', assertAssetId(assetId), `v${version}`, `${size}.webp`)
}

export function posterPath(
  cacheDir: string,
  assetId: string,
  version: number,
  size: number,
): string {
  return path.join(
    cacheDir,
    'thumbs',
    assertAssetId(assetId),
    `v${version}`,
    `p${POSTER_SCHEME}-${size}.webp`,
  )
}

export function previewPath(cacheDir: string, assetId: string, version: number): string {
  return path.join(cacheDir, 'previews', assertAssetId(assetId), `v${version}`, '1600.webp')
}

export function hlsDir(cacheDir: string, assetId: string, version: number): string {
  return path.join(cacheDir, 'hls', assertAssetId(assetId), `v${version}`)
}

export function hlsPlaylistPath(cacheDir: string, assetId: string, version: number): string {
  return path.join(hlsDir(cacheDir, assetId, version), 'master.m3u8')
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export function cacheRelativePath(cacheDir: string, absolutePath: string): string {
  const relative = path.relative(cacheDir, absolutePath)
  return relative.split(path.sep).join('/')
}
