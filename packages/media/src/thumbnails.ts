import { execFile } from 'node:child_process'
import { mkdtemp, rename, rm, stat, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import {
  PREVIEW_QUALITY,
  PREVIEW_SIZE,
  THUMBNAIL_QUALITY,
  THUMBNAIL_SIZES,
} from '@mediavault/shared'
import { ensureDir, previewPath, thumbnailPath } from './paths'

const run = promisify(execFile)

export async function fileExists(target: string): Promise<boolean> {
  try {
    const info = await stat(target)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

async function writeAtomic(target: string, produce: (tmp: string) => Promise<void>): Promise<void> {
  await ensureDir(path.dirname(target))
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await produce(tmp)
    await rename(tmp, target)
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }
}

function imagePipeline(src: string, size: number) {
  return sharp(src, { failOn: 'none' })
    .rotate()
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: THUMBNAIL_QUALITY })
}

export async function ensureImageThumbnail(
  src: string,
  cacheDir: string,
  assetId: string,
  version: number,
  size: number,
): Promise<string> {
  const target = thumbnailPath(cacheDir, assetId, version, size)
  if (await fileExists(target)) return target
  await writeAtomic(target, async (tmp) => {
    await imagePipeline(src, size).toFile(tmp)
  })
  return target
}

export async function generateImageThumbnails(
  src: string,
  cacheDir: string,
  assetId: string,
  version: number,
): Promise<string[]> {
  const written: string[] = []
  for (const size of THUMBNAIL_SIZES) {
    written.push(await ensureImageThumbnail(src, cacheDir, assetId, version, size))
  }
  return written
}

export async function ensurePreview(
  src: string,
  cacheDir: string,
  assetId: string,
  version: number,
): Promise<string> {
  const target = previewPath(cacheDir, assetId, version)
  if (await fileExists(target)) return target
  await writeAtomic(target, async (tmp) => {
    await sharp(src, { failOn: 'none' })
      .rotate()
      .resize(PREVIEW_SIZE, PREVIEW_SIZE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: PREVIEW_QUALITY })
      .toFile(tmp)
  })
  return target
}

async function extractVideoFrame(src: string, durationMs: number | null): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mediavault-poster-'))
  const frame = path.join(dir, 'frame.jpg')
  const seconds = durationMs && durationMs > 1000 ? Math.min(2, durationMs / 4000) : 0
  try {
    await run('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-ss',
      seconds.toFixed(2),
      '-i',
      src,
      '-frames:v',
      '1',
      '-q:v',
      '3',
      frame,
    ])
    return frame
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

export async function generateVideoThumbnails(
  src: string,
  cacheDir: string,
  assetId: string,
  version: number,
  durationMs: number | null,
): Promise<string[]> {
  const targets = THUMBNAIL_SIZES.map((size) => thumbnailPath(cacheDir, assetId, version, size))
  const missing = [] as number[]
  for (const [index, target] of targets.entries()) {
    if (!(await fileExists(target))) missing.push(index)
  }
  if (missing.length === 0) return targets

  const frame = await extractVideoFrame(src, durationMs)
  const frameDir = path.dirname(frame)
  try {
    for (const index of missing) {
      const size = THUMBNAIL_SIZES[index]
      if (size === undefined) continue
      const target = targets[index]
      if (!target) continue
      await writeAtomic(target, async (tmp) => {
        await imagePipeline(frame, size).toFile(tmp)
      })
    }
  } finally {
    await rm(frameDir, { recursive: true, force: true })
  }
  return targets
}
