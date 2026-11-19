import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { ensureDir, hlsDir, hlsPlaylistPath, resolveInside } from './paths'
import { fileExists } from './thumbnails'

/** A deployment may pin a specific ffmpeg build. */
function ffmpegBin(): string {
  return process.env.FFMPEG_PATH?.trim() || 'ffmpeg'
}

/** Bump when the produced playlist or segments change meaning. */
export const HLS_PROFILE_VERSION = 'h264-aac-v2'
export const HLS_SEGMENT_TIME = 4
const MPEG_TS_PACKET = 188

export interface HlsOptions {
  hwaccel: 'nvenc' | null
  width: number | null
  durationMs?: number | null
  signal?: AbortSignal
}

/** The requested output shape; the encoder that runs it is not part of the key. */
export function hlsProfileHash(options: Pick<HlsOptions, 'width'>): string {
  const profile = {
    version: HLS_PROFILE_VERSION,
    video: 'h264',
    preset: 'veryfast',
    crf: 23,
    pixelFormat: 'yuv420p',
    audio: 'aac-128k-stereo',
    segmentSeconds: HLS_SEGMENT_TIME,
    scale: options.width && options.width > 1920 ? '1920' : 'source-even',
  }
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex').slice(0, 16)
}

function scaleFilter(width: number | null): string {
  if (width && width > 1920) return 'scale=1920:-2'
  return 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
}

function videoCodecArgs(encoder: 'libx264' | 'nvenc'): string[] {
  return encoder === 'nvenc'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23']
}

function ffmpegArgs(
  src: string,
  dir: string,
  options: HlsOptions,
  encoder: 'libx264' | 'nvenc',
  progress: boolean,
): string[] {
  return [
    '-v',
    'error',
    '-y',
    ...(progress ? ['-nostats', '-progress', 'pipe:1'] : []),
    '-i',
    src,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    ...videoCodecArgs(encoder),
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
    String(HLS_SEGMENT_TIME),
    '-hls_playlist_type',
    'vod',
    '-hls_segment_filename',
    path.join(dir, 'seg%05d.ts'),
    path.join(dir, 'master.m3u8'),
  ]
}

/**
 * NVENC can fail because the card is absent, or because this particular input
 * is bad. Only the first is worth a CPU retry; anything else would burn a full
 * second encode to fail the same way.
 */
export function isNvencUnavailable(stderr: string): boolean {
  const text = stderr.toLowerCase()
  return [
    'cannot load libnvidia-encode',
    'cannot load libcuda',
    'no capable devices found',
    'opencodesessionex failed',
    'initializeencoder failed',
    'no nvenc capable devices',
    "unknown encoder 'h264_nvenc'",
    'cuda_error_no_device',
  ].some((marker) => text.includes(marker))
}

export class HlsAbortedError extends Error {
  constructor() {
    super('hls encode was aborted')
    this.name = 'HlsAbortedError'
  }
}

export class ProcessTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProcessTimeoutError'
  }
}

const STDERR_TAIL_BYTES = 8 * 1024
const STALL_TIMEOUT_MS = 5 * 60_000

class NvencUnavailableError extends Error {
  constructor() {
    super('nvenc is not available')
    this.name = 'NvencUnavailableError'
  }
}

function abortError(signal?: AbortSignal): HlsAbortedError | null {
  return signal?.aborted ? new HlsAbortedError() : null
}

async function syncFile(target: string): Promise<void> {
  const handle = await open(target, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Directory fsync is best effort: some filesystems reject it and the rename is still ordered. */
async function syncDir(target: string): Promise<void> {
  try {
    await syncFile(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR' && code !== 'EPERM') throw error
  }
}

interface PlaylistValidation {
  segments: string[]
  durationSeconds: number
}

/**
 * A zero exit code is not proof of a usable output. The playlist must be VOD,
 * every URI must stay inside the directory, and each segment must be a real
 * MPEG-TS file before anything becomes visible.
 */
async function validatePlaylist(dir: string, playlist: string): Promise<PlaylistValidation> {
  const text = await readFile(playlist, 'utf8')
  if (!text.startsWith('#EXTM3U')) throw new Error('playlist is missing #EXTM3U')
  if (!text.includes('#EXT-X-ENDLIST')) throw new Error('playlist is not a VOD playlist')

  const segments: string[] = []
  let durationSeconds = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('#EXTINF:')) {
      durationSeconds += Number.parseFloat(line.slice('#EXTINF:'.length)) || 0
      continue
    }
    if (line.startsWith('#')) continue
    if (!/^seg\d{5}\.ts$/.test(line)) throw new Error(`unexpected playlist entry: ${line}`)
    const target = resolveInside(dir, line)
    if (!target) throw new Error(`segment escapes the generation: ${line}`)
    const info = await stat(target)
    if (!info.isFile() || info.size <= 0 || info.size % MPEG_TS_PACKET !== 0) {
      throw new Error(`segment is not a whole MPEG-TS file: ${line}`)
    }
    const handle = await open(target, 'r')
    try {
      const first = Buffer.alloc(1)
      await handle.read(first, 0, 1, 0)
      if (first[0] !== 0x47) throw new Error(`segment has no MPEG-TS sync byte: ${line}`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    segments.push(line)
  }

  if (segments.length === 0) throw new Error('playlist has no segments')
  if (durationSeconds <= 0) throw new Error('playlist has no segment durations')
  await syncFile(playlist)
  return { segments, durationSeconds }
}

export interface HlsGenerationOptions extends HlsOptions {
  assetId: string
  fileVersion: number
  generationId: string
  attemptId: string
  onProgress?: (percent: number) => void
  /** Re-checked after encoding, right before the rename that publishes the attempt. */
  canPublish?: () => boolean
}

export interface HlsGenerationResult {
  /** Relative to the cache root; the database stores this exact attempt directory. */
  storageRel: string
  playlistRel: string
  encoder: 'nvenc' | 'libx264'
  segmentCount: number
}

interface EncodeOutcome {
  encoder: 'nvenc' | 'libx264'
}

interface FfmpegRunOptions {
  /** Parse `-progress pipe:1` output and report percentages. */
  progress: boolean
  /** Wall-clock cap; a stuck encoder must not hold the card forever. */
  timeoutMs: number
  /** Kill after this long without a progress line; 0 disables the watchdog. */
  stallTimeoutMs: number
}

/** Exported so the bounded-process test can drive the wall clock directly. */
export async function runFfmpeg(
  src: string,
  dir: string,
  options: HlsOptions & { onProgress?: (percent: number) => void },
  encoder: 'nvenc' | 'libx264',
  runOptions: FfmpegRunOptions,
): Promise<EncodeOutcome> {
  if (options.signal?.aborted) throw new HlsAbortedError()
  const proc = Bun.spawn([ffmpegBin(), ...ffmpegArgs(src, dir, options, encoder, runOptions.progress)], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  let timedOut = false
  const kill = () => proc.kill(9)
  options.signal?.addEventListener('abort', kill, { once: true })
  const wallTimer = setTimeout(() => {
    timedOut = true
    kill()
  }, runOptions.timeoutMs)
  let lastProgressAt = Date.now()
  const stallTimer =
    runOptions.stallTimeoutMs > 0
      ? setInterval(() => {
          if (Date.now() - lastProgressAt > runOptions.stallTimeoutMs) {
            timedOut = true
            kill()
          }
        }, 15_000)
      : null

  let stderrTail = ''
  const stderrPump = (async () => {
    const reader = proc.stderr.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      stderrTail = (stderrTail + decoder.decode(value, { stream: true })).slice(-STDERR_TAIL_BYTES)
    }
  })()

  const durationUs = options.durationMs && options.durationMs > 0 ? options.durationMs * 1000 : null
  let buffer = ''
  let lastPercent = -1
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!runOptions.progress) continue
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('out_time_us=') && durationUs !== null) {
          lastProgressAt = Date.now()
          const us = Number.parseInt(line.slice('out_time_us='.length), 10)
          if (Number.isFinite(us) && us >= 0) {
            const percent = Math.min(99, Math.floor((us / durationUs) * 100))
            if (percent > lastPercent) {
              lastPercent = percent
              options.onProgress?.(percent)
            }
          }
        }
        newline = buffer.indexOf('\n')
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', kill)
    clearTimeout(wallTimer)
    if (stallTimer) clearInterval(stallTimer)
  }

  const code = await proc.exited
  await stderrPump
  if (options.signal?.aborted) throw new HlsAbortedError()
  if (timedOut) {
    throw new ProcessTimeoutError(`ffmpeg exceeded its ${Math.round(runOptions.timeoutMs / 1000)}s budget`)
  }
  if (code !== 0) {
    const error = new Error(
      `ffmpeg exited with ${code}: ${stderrTail.trim().split('\n').slice(-3).join(' | ')}`,
    )
    ;(error as { stderr?: string }).stderr = stderrTail
    throw error
  }
  return { encoder }
}

async function encodeAttempt(
  src: string,
  dir: string,
  options: HlsGenerationOptions,
  encoder: 'nvenc' | 'libx264',
): Promise<EncodeOutcome> {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  try {
    return await runFfmpeg(src, dir, options, encoder, {
      progress: true,
      timeoutMs: Math.max(10 * 60_000, (options.durationMs ?? 0) * 4),
      stallTimeoutMs: STALL_TIMEOUT_MS,
    })
  } catch (error) {
    const aborted = abortError(options.signal)
    if (aborted) throw aborted
    const stderr = String((error as { stderr?: string }).stderr ?? '')
    if (encoder === 'nvenc' && isNvencUnavailable(stderr)) throw new NvencUnavailableError()
    throw error
  }
}

/**
 * Encodes into a private staging directory and publishes it only after the
 * playlist and every segment pass validation. The final directory includes the
 * attempt id, so two workers racing on one generation can never overwrite each
 * other; the loser removes its own directory.
 */
export async function generateHlsGeneration(
  src: string,
  cacheDir: string,
  options: HlsGenerationOptions,
): Promise<HlsGenerationResult | null> {
  const versionDir = hlsDir(cacheDir, options.assetId, options.fileVersion)
  const generationDir = path.join(versionDir, 'g')
  const staging = path.join(generationDir, `.tmp-${options.generationId}-${options.attemptId}`)
  const finalDir = path.join(generationDir, `${options.generationId}-${options.attemptId}`)

  await ensureDir(generationDir)
  let outcome: EncodeOutcome
  let segmentCount = 0
  try {
    try {
      outcome = await encodeAttempt(
        src,
        staging,
        options,
        options.hwaccel === 'nvenc' ? 'nvenc' : 'libx264',
      )
    } catch (error) {
      if (!(error instanceof NvencUnavailableError)) throw error
      console.warn('[hls] nvenc is unavailable, encoding this generation on the cpu')
      outcome = await encodeAttempt(src, staging, options, 'libx264')
    }

    const playlist = path.join(staging, 'master.m3u8')
    if (!(await fileExists(playlist))) throw new Error('ffmpeg finished without writing a playlist')
    const validation = await validatePlaylist(staging, playlist)
    segmentCount = validation.segments.length

    const aborted = abortError(options.signal)
    if (aborted) throw aborted
    if (options.canPublish && !options.canPublish()) {
      await rm(staging, { recursive: true, force: true })
      return null
    }

    if (await pathOccupied(finalDir)) throw new Error(`attempt directory already exists: ${finalDir}`)
    await syncDir(staging)
    await rename(staging, finalDir)
    await syncDir(generationDir)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }

  const storageRel = path.relative(cacheDir, finalDir).split(path.sep).join('/')
  return {
    storageRel,
    playlistRel: `${storageRel}/master.m3u8`,
    encoder: outcome.encoder,
    segmentCount,
  }
}

async function pathOccupied(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
}

/**
 * Legacy fixed-directory encode, used while HLS_GENERATIONS_ENABLED is off.
 * NVENC is attempted first when requested; an abort never falls back.
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
    await runFfmpeg(src, tmpDir, options, encoder, {
      progress: false,
      timeoutMs: Math.max(10 * 60_000, (options.durationMs ?? 0) * 4),
      stallTimeoutMs: 0,
    })
  }

  try {
    if (options.hwaccel === 'nvenc') {
      try {
        await encode('nvenc')
      } catch (error) {
        if (abortError(options.signal)) throw new HlsAbortedError()
        const stderr = (error as { stderr?: string }).stderr?.trim().split('\n')[0]
        console.warn(`[hls] nvenc failed, encoding on the cpu${stderr ? `: ${stderr}` : ''}`)
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
