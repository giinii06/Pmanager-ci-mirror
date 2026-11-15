import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sharp from 'sharp'
import exifr from 'exifr'

const run = promisify(execFile)

export interface ImageProbe {
  width: number | null
  height: number | null
  takenAt: number
}

export interface VideoProbe {
  width: number | null
  height: number | null
  durationMs: number | null
  takenAt: number
  videoCodec: string | null
  audioCodec: string | null
}

export async function probeImage(absPath: string, fallbackTakenAt: number): Promise<ImageProbe> {
  const meta = await sharp(absPath, { failOn: 'none' }).metadata()
  let width = meta.width ?? null
  let height = meta.height ?? null
  const orientation = meta.orientation ?? 1
  if (orientation >= 5 && orientation <= 8 && width !== null && height !== null) {
    ;[width, height] = [height, width]
  }

  let takenAt = fallbackTakenAt
  try {
    const exif = await exifr.parse(absPath, { pick: ['DateTimeOriginal', 'CreateDate'] })
    const captured = exif?.DateTimeOriginal ?? exif?.CreateDate
    if (captured instanceof Date && Number.isFinite(captured.getTime())) {
      takenAt = captured.getTime()
    }
  } catch {
    // A missing or malformed EXIF block is normal. Fall back to the file time.
  }

  return { width, height, takenAt }
}

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  duration?: string
  tags?: Record<string, string>
}

interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: {
    duration?: string
    tags?: Record<string, string>
  }
}

export async function probeVideo(absPath: string, fallbackTakenAt: number): Promise<VideoProbe> {
  const { stdout } = await run(
    'ffprobe',
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      absPath,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  )
  const info = JSON.parse(stdout) as FfprobeOutput
  const video = info.streams?.find((stream) => stream.codec_type === 'video')
  const audio = info.streams?.find((stream) => stream.codec_type === 'audio')
  const durationSeconds = Number(info.format?.duration ?? video?.duration ?? 0)
  const createdAt = info.format?.tags?.creation_time ?? video?.tags?.creation_time
  const parsed = createdAt ? Date.parse(createdAt) : Number.NaN

  return {
    width: video?.width ?? null,
    height: video?.height ?? null,
    durationMs: Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.round(durationSeconds * 1000) : null,
    takenAt: Number.isFinite(parsed) ? parsed : fallbackTakenAt,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
  }
}
