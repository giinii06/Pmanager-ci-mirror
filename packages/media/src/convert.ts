import { execFile } from 'node:child_process'
import { rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { uniqueDestPath } from './paths'
import { probeVideo } from './probe'

const run = promisify(execFile)

export interface ImageConvertResult {
  outputPath: string
  converted: boolean
  bytes: number
}

export interface VideoTranscodeOptions {
  hwaccel?: 'nvenc' | null
  signal?: AbortSignal
}

export interface VideoConvertResult {
  outputPath: string
  transcoded: boolean
  bytes: number
}

function makeTempPath(target: string, suffix: string): string {
  return `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp${suffix}`
}

async function assertDecodableImage(filePath: string): Promise<number> {
  const outStat = await stat(filePath)
  if (outStat.size === 0) {
    throw new Error(`converted JPEG is empty: ${filePath}`)
  }
  await sharp(filePath, { failOn: 'error' }).stats()
  return outStat.size
}

export async function convertImageToJpeg95(srcPath: string): Promise<ImageConvertResult> {
  const srcStat = await stat(srcPath)
  if (!srcStat.isFile() || srcStat.size === 0) {
    throw new Error(`source image is missing or empty: ${srcPath}`)
  }

  const meta = await sharp(srcPath, { failOn: 'error' }).metadata()
  if ((meta.pages ?? 1) > 1) {
    return { outputPath: srcPath, converted: false, bytes: srcStat.size }
  }

  const dir = path.dirname(srcPath)
  const parsed = path.parse(srcPath)
  const isJpegAlready = /^\.jpe?g$/i.test(parsed.ext)
  const targetPath = isJpegAlready
    ? srcPath
    : await uniqueDestPath(dir, parsed.name, '.jpg', srcPath)
  const tmpPath = makeTempPath(targetPath, '.jpg')

  try {
    let pipeline = sharp(srcPath, { failOn: 'error' }).rotate().keepIccProfile()
    if (meta.hasAlpha) {
      pipeline = pipeline.flatten({ background: '#000000' })
    }
    await pipeline.jpeg({ quality: 95 }).toFile(tmpPath)

    const bytes = await assertDecodableImage(tmpPath)
    await rename(tmpPath, targetPath)
    if (path.resolve(srcPath) !== path.resolve(targetPath)) {
      await unlink(srcPath)
    }
    return { outputPath: targetPath, converted: true, bytes }
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined)
    throw error
  }
}

function isWebCompatible(ext: string, codec: string | null, pixFmt: string | null, audioCodec: string | null): boolean {
  if (ext.toLowerCase() !== '.mp4') return false
  if (codec !== 'h264') return false
  if (pixFmt !== null && pixFmt !== 'yuv420p') return false
  return audioCodec === null || audioCodec === 'aac'
}

function buildTranscodeArgs(src: string, tmpOut: string, encoder: 'h264_nvenc' | 'libx264'): string[] {
  const codecArgs =
    encoder === 'h264_nvenc'
      ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '20', '-b:v', '0']
      : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20']

  return [
    '-v',
    'error',
    '-y',
    '-i',
    src,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    ...codecArgs,
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    tmpOut,
  ]
}

async function verifyVideoFile(filePath: string, expectedAudio: boolean): Promise<number> {
  const info = await stat(filePath)
  if (!info.isFile() || info.size === 0) {
    throw new Error(`video output is missing or empty: ${filePath}`)
  }
  const probed = await probeVideo(filePath, Date.now())
  if (probed.videoCodec !== 'h264') {
    throw new Error(`expected h264 video stream, got ${probed.videoCodec ?? 'none'}`)
  }
  if (!probed.width || !probed.height || !probed.durationMs || probed.durationMs <= 0) {
    throw new Error(`transcoded video missing valid dimensions or duration: ${filePath}`)
  }
  if (expectedAudio && probed.audioCodec !== 'aac') {
    throw new Error(`expected aac audio stream, got ${probed.audioCodec ?? 'none'}`)
  }
  await run('ffmpeg', ['-v', 'error', '-i', filePath, '-c', 'copy', '-f', 'null', '-'], {
    maxBuffer: 4 * 1024 * 1024,
  })
  await run('ffmpeg', ['-v', 'error', '-t', '1', '-i', filePath, '-f', 'null', '-'], {
    maxBuffer: 4 * 1024 * 1024,
  })
  return info.size
}

/**
 * Ensures a video uses H.264/yuv420p + AAC in an MP4 container. Tries NVENC
 * first when requested and verifies decode + streams before removing source.
 */
export async function ensureWebCompatibleVideo(
  srcPath: string,
  options: VideoTranscodeOptions = {},
): Promise<VideoConvertResult> {
  const srcProbe = await probeVideo(srcPath, Date.now())
  const parsed = path.parse(srcPath)

  if (isWebCompatible(parsed.ext, srcProbe.videoCodec, srcProbe.pixFmt, srcProbe.audioCodec)) {
    const info = await stat(srcPath)
    return { outputPath: srcPath, transcoded: false, bytes: info.size }
  }

  const targetPath =
    parsed.ext.toLowerCase() === '.mp4'
      ? srcPath
      : await uniqueDestPath(path.dirname(srcPath), parsed.name, '.mp4', srcPath)
  const tmpOut = makeTempPath(targetPath, '.mp4')

  const encode = async (encoder: 'h264_nvenc' | 'libx264') => {
    await run('ffmpeg', buildTranscodeArgs(srcPath, tmpOut, encoder), {
      maxBuffer: 16 * 1024 * 1024,
      signal: options.signal,
    })
  }

  try {
    if (options.hwaccel === 'nvenc') {
      try {
        await encode('h264_nvenc')
      } catch (error) {
        if (options.signal?.aborted) throw error
        const firstLine = (error as { stderr?: string }).stderr?.trim().split('\n')[0]
        console.warn(`[convert] nvenc failed, falling back to libx264${firstLine ? `: ${firstLine}` : ''}`)
        await unlink(tmpOut).catch(() => undefined)
        await encode('libx264')
      }
    } else {
      await encode('libx264')
    }

    const bytes = await verifyVideoFile(tmpOut, srcProbe.audioCodec !== null)
    await rename(tmpOut, targetPath)
    if (path.resolve(srcPath) !== path.resolve(targetPath)) {
      await unlink(srcPath)
    }
    return { outputPath: targetPath, transcoded: true, bytes }
  } catch (error) {
    await unlink(tmpOut).catch(() => undefined)
    throw error
  }
}
