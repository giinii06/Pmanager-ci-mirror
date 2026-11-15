import { execFile } from 'node:child_process'
import { rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { ensureDir, hlsDir, hlsPlaylistPath } from './paths'
import { fileExists } from './thumbnails'

const run = promisify(execFile)

export interface HlsOptions {
  hwaccel: 'nvenc' | null
  width: number | null
}

function scaleFilter(width: number | null): string {
  if (width && width > 1920) return 'scale=1920:-2'
  return 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
}

function ffmpegArgs(
  src: string,
  dir: string,
  options: HlsOptions,
  encoder: 'libx264' | 'nvenc',
): string[] {
  const videoCodec =
    encoder === 'nvenc'
      ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23']

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
    ...videoCodec,
    '-pix_fmt',
    'yuv420p',
    '-vf',
    scaleFilter(options.width),
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ac',
    '2',
    '-hls_time',
    '4',
    '-hls_playlist_type',
    'vod',
    '-hls_segment_filename',
    path.join(dir, 'seg%05d.ts'),
    path.join(dir, 'master.m3u8'),
  ]
}

/**
 * Transcodes to H.264/AAC HLS. NVENC is attempted first when requested and
 * falls back to libx264 so a missing GPU never blocks playback.
 */
export async function generateHls(
  src: string,
  cacheDir: string,
  assetId: string,
  version: number,
  options: HlsOptions,
): Promise<string> {
  const playlist = hlsPlaylistPath(cacheDir, assetId, version)
  if (await fileExists(playlist)) return playlist

  const finalDir = hlsDir(cacheDir, assetId, version)
  const tmpDir = `${finalDir}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  await ensureDir(tmpDir)

  const encode = async (encoder: 'libx264' | 'nvenc') => {
    await run('ffmpeg', ffmpegArgs(src, tmpDir, options, encoder), {
      maxBuffer: 16 * 1024 * 1024,
    })
  }

  try {
    if (options.hwaccel === 'nvenc') {
      try {
        await encode('nvenc')
      } catch {
        await rm(path.join(tmpDir, 'master.m3u8'), { force: true })
        await encode('libx264')
      }
    } else {
      await encode('libx264')
    }

    if (!(await fileExists(path.join(tmpDir, 'master.m3u8')))) {
      throw new Error('ffmpeg finished without writing a playlist')
    }
    await rm(finalDir, { recursive: true, force: true })
    await ensureDir(path.dirname(finalDir))
    await rename(tmpDir, finalDir)
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true })
    throw error
  }

  return playlist
}
