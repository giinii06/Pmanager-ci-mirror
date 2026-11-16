import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { generateVideoThumbnails, planVideoPoster } from './thumbnails'

function probeFfmpeg(): boolean {
  try {
    return Bun.spawnSync(['ffmpeg', '-version']).exitCode === 0
  } catch {
    return false
  }
}

const ffmpegAvailable = probeFfmpeg()

const CLIP_WIDTH = 320
const CLIP_HEIGHT = 240
const CLIP_RATE = 10
const ASSET_ID = 'postercuttest'
const POSTER_DIR = path.join('thumbs', ASSET_ID, 'v1')

function encode(args: string[], clip: string): void {
  const result = Bun.spawnSync(['ffmpeg', '-v', 'error', '-y', ...args, clip])
  if (result.exitCode !== 0) throw new Error(`ffmpeg failed: ${result.stderr.toString()}`)
}

function colorSource(color: string, seconds: number): string[] {
  const size = `${CLIP_WIDTH}x${CLIP_HEIGHT}`
  return ['-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=${CLIP_RATE}:d=${seconds}`]
}

function encodeFlat(color: string, seconds: number, clip: string): void {
  encode(
    [
      ...colorSource(color, seconds),
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
    ],
    clip,
  )
}

function encodeBlackThenRed(clip: string): void {
  encode(
    [
      ...colorSource('black', 19),
      ...colorSource('red', 11),
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]',
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
    ],
    clip,
  )
}

/**
 * Fades in over the first 15 seconds, so the poster's brightness says which second
 * it came from. A flat clip cannot tell the 15.0s fallback from the 2s early frame,
 * and any hard colour change would register as a scene cut.
 */
function encodeFadingBlue(clip: string): void {
  encode(
    [
      ...colorSource('blue', 30),
      '-vf',
      'fade=t=in:st=0:d=15',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
    ],
    clip,
  )
}

type Pixel = { r: number; g: number; b: number }

async function firstPixel(file: string): Promise<Pixel> {
  const { data } = await sharp(file).raw().toBuffer({ resolveWithObject: true })
  // -1 fails every colour assertion, so a truncated buffer cannot pass by accident.
  return { r: data[0] ?? -1, g: data[1] ?? -1, b: data[2] ?? -1 }
}

async function renderPoster(
  build: (clip: string) => void,
  durationMs: number,
): Promise<Pixel> {
  const clips = await mkdtemp(path.join(os.tmpdir(), 'mediavault-clip-'))
  const cache = await mkdtemp(path.join(os.tmpdir(), 'mediavault-poster-cache-'))
  try {
    const clip = path.join(clips, 'clip.mp4')
    build(clip)
    await generateVideoThumbnails(clip, cache, ASSET_ID, 1, durationMs)
    const posterDir = path.join(cache, POSTER_DIR)
    expect((await readdir(posterDir)).sort()).toEqual(['p2-320.webp', 'p2-640.webp'])
    return await firstPixel(path.join(posterDir, 'p2-640.webp'))
  } finally {
    await rm(clips, { recursive: true, force: true })
    await rm(cache, { recursive: true, force: true })
  }
}

describe('planVideoPoster', () => {
  test('keeps the early frame at or under the cut point', () => {
    expect(planVideoPoster(null)).toEqual({ kind: 'early', seconds: 0 })
    expect(planVideoPoster(1000)).toEqual({ kind: 'early', seconds: 0 })
    expect(planVideoPoster(4000)).toEqual({ kind: 'early', seconds: 1 })
    expect(planVideoPoster(8000)).toEqual({ kind: 'early', seconds: 2 })
    expect(planVideoPoster(15_000)).toEqual({ kind: 'early', seconds: 2 })
  })

  test('cuts past the cut point', () => {
    for (const durationMs of [15_001, 60_000, 3_600_000]) {
      expect(planVideoPoster(durationMs)).toEqual({
        kind: 'cut',
        fromSeconds: 15,
        windowSeconds: 20,
      })
    }
  })
})

describe('video posters', () => {
  test.skipIf(!ffmpegAvailable)('takes a scene change past the cut point', async () => {
    const pixel = await renderPoster(encodeBlackThenRed, 30_000)
    expect(pixel.r).toBeGreaterThan(200)
    expect(pixel.g).toBeLessThan(60)
    expect(pixel.b).toBeLessThan(60)
  })

  test.skipIf(!ffmpegAvailable)('falls back to the cut point when nothing changes', async () => {
    const pixel = await renderPoster(encodeFadingBlue, 30_000)
    expect(pixel.b).toBeGreaterThan(200)
    expect(pixel.r).toBeLessThan(60)
    expect(pixel.g).toBeLessThan(60)
  })

  test.skipIf(!ffmpegAvailable)('keeps the early frame for a short video', async () => {
    const pixel = await renderPoster((clip) => encodeFlat('0x00FF00', 6, clip), 6_000)
    expect(pixel.g).toBeGreaterThan(180)
    expect(pixel.r).toBeLessThan(60)
    expect(pixel.b).toBeLessThan(60)
  })
})
