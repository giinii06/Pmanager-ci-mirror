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
import { ensureDir, posterPath, previewPath, thumbnailPath } from './paths'

const run = promisify(execFile)

export async function fileExists(target: string): Promise<boolean> {
  try {
    const info = await stat(target)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

export interface WriteAtomicOptions {
  /** Guard evaluated right before `rename(tmp, target)` so an expired lease cannot publish stale output. */
  canPublish?: () => boolean
}

async function writeAtomic(
  target: string,
  produce: (tmp: string) => Promise<void>,
  options: WriteAtomicOptions = {},
): Promise<boolean> {
  await ensureDir(path.dirname(target))
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await produce(tmp)
    const written = await fileExists(tmp)
    if (!written) throw new Error(`thumbnail write produced empty file: ${tmp}`)
    if (options.canPublish && !options.canPublish()) {
      await unlink(tmp).catch(() => undefined)
      return false
    }
    await rename(tmp, target)
    return true
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
  options?: WriteAtomicOptions,
): Promise<string> {
  const target = thumbnailPath(cacheDir, assetId, version, size)
  if (await fileExists(target)) return target
  await writeAtomic(
    target,
    async (tmp) => {
      await imagePipeline(src, size).toFile(tmp)
    },
    options,
  )
  return target
}

export async function generateImageThumbnails(
  src: string,
  cacheDir: string,
  assetId: string,
  version: number,
  options?: WriteAtomicOptions,
): Promise<string[]> {
  const written: string[] = []
  for (const size of THUMBNAIL_SIZES) {
    written.push(await ensureImageThumbnail(src, cacheDir, assetId, version, size, options))
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

export const POSTER_CUT_AFTER_MS = 15_000
export const POSTER_CUT_WINDOW_SECONDS = 20
export const POSTER_SCENE_THRESHOLD = 0.3

export type PosterPlan =
  | { kind: 'early'; seconds: number }
  | { kind: 'cut'; fromSeconds: number; windowSeconds: number }

/**
 * Past the cut point the poster comes from a scene change after it, so it is not
 * the opening seconds. A shorter video has no such region and keeps the early frame.
 */
export function planVideoPoster(durationMs: number | null): PosterPlan {
  if (durationMs === null || durationMs <= POSTER_CUT_AFTER_MS) {
    return {
      kind: 'early',
      seconds: durationMs && durationMs > 1000 ? Math.min(2, durationMs / 4000) : 0,
    }
  }
  return {
    kind: 'cut',
    fromSeconds: POSTER_CUT_AFTER_MS / 1000,
    windowSeconds: POSTER_CUT_WINDOW_SECONDS,
  }
}

function posterArgs(src: string, frame: string, plan: PosterPlan): string[] {
  const args = ['-v', 'error', '-y', '-ss']
  args.push(plan.kind === 'early' ? plan.seconds.toFixed(2) : plan.fromSeconds.toFixed(2))
  if (plan.kind === 'cut') args.push('-t', String(plan.windowSeconds))
  args.push('-i', src)
  if (plan.kind === 'cut') args.push('-vf', `select='gt(scene,${POSTER_SCENE_THRESHOLD})'`)
  args.push('-frames:v', '1', '-q:v', '3', frame)
  return args
}

async function extractVideoFrame(src: string, durationMs: number | null): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mediavault-poster-'))
  const frame = path.join(dir, 'frame.jpg')
  const plan = planVideoPoster(durationMs)
  try {
    if (plan.kind === 'early') {
      await run('ffmpeg', posterArgs(src, frame, plan))
      return frame
    }
    // No scene change in the window makes ffmpeg exit non-zero without a frame,
    // so the fallback reads the file rather than the exit code.
    await run('ffmpeg', posterArgs(src, frame, plan)).catch(() => undefined)
    if (await fileExists(frame)) return frame
    await run('ffmpeg', posterArgs(src, frame, { kind: 'early', seconds: plan.fromSeconds }))
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
  options?: WriteAtomicOptions,
): Promise<string[]> {
  const targets = THUMBNAIL_SIZES.map((size) => posterPath(cacheDir, assetId, version, size))
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
      await writeAtomic(
        target,
        async (tmp) => {
          await imagePipeline(frame, size).toFile(tmp)
        },
        options,
      )
    }
  } finally {
    await rm(frameDir, { recursive: true, force: true })
  }
  return targets
}

/** Raised when the fence refuses publication, so the caller can report a conflict. */
export class PosterPublishRefusedError extends Error {
  constructor() {
    super('the asset changed while the poster was being captured')
    this.name = 'PosterPublishRefusedError'
  }
}

/**
 * Extracts a frame at `positionMs` from a paused video and replaces every poster
 * size for the current file version while leaving the source video untouched.
 * Every size is staged before the fence runs, so a refused or failed capture
 * leaves the previous poster in place.
 */
export async function extractCustomVideoPoster(
  src: string,
  cacheDir: string,
  assetId: string,
  version: number,
  positionMs: number,
  options: WriteAtomicOptions = {},
): Promise<string[]> {
  const seconds = Math.max(0, positionMs / 1000)
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mediavault-custom-poster-'))
  const frame = path.join(dir, 'frame.jpg')
  const targets = THUMBNAIL_SIZES.map((size) => posterPath(cacheDir, assetId, version, size))
  const staged: Array<{ tmp: string; target: string }> = []

  try {
    await run('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-ss',
      seconds.toFixed(3),
      '-i',
      src,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      frame,
    ]).catch(() => undefined)

    if (!(await fileExists(frame))) {
      await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-frames:v', '1', '-q:v', '2', frame])
    }

    for (let index = 0; index < THUMBNAIL_SIZES.length; index += 1) {
      const size = THUMBNAIL_SIZES[index]
      const target = targets[index]
      if (size === undefined || !target) continue
      await ensureDir(path.dirname(target))
      const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      staged.push({ tmp, target })
      await imagePipeline(frame, size).toFile(tmp)
      if (!(await fileExists(tmp))) throw new Error(`poster write produced empty file: ${tmp}`)
    }

    if (options.canPublish && !options.canPublish()) throw new PosterPublishRefusedError()
    for (const { tmp, target } of staged) await rename(tmp, target)
    return targets
  } catch (error) {
    for (const { tmp } of staged) await unlink(tmp).catch(() => undefined)
    throw error
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
