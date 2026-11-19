import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  HlsAbortedError,
  ProcessTimeoutError,
  generateHlsGeneration,
  hlsProfileHash,
  isNvencUnavailable,
  runFfmpeg,
} from './hls'

const fixture = path.join(import.meta.dir, 'hls.fixture.ts')
const modeFile = path.join(tmpdir(), 'mv-fake-ffmpeg.mode')
const dirs: string[] = []

function setMode(mode: string): void {
  writeFileSync(modeFile, mode)
}

function clearMode(): void {
  rmSync(modeFile, { force: true })
}

beforeAll(() => {
  chmodSync(fixture, 0o755)
  process.env.FFMPEG_PATH = fixture
})

afterAll(() => {
  delete process.env.FFMPEG_PATH
  clearMode()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mv-hls-'))
  dirs.push(dir)
  const cacheDir = path.join(dir, 'cache')
  const source = path.join(dir, 'clip.mp4')
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(source, 'source')
  return { dir, cacheDir, source }
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    assetId: 'asset1',
    fileVersion: 1,
    generationId: 'gen1',
    attemptId: 'attempt1',
    hwaccel: null as 'nvenc' | null,
    width: 1280,
    durationMs: 10_000,
    ...overrides,
  }
}

describe('immutable HLS generation encode', () => {
  test('profile hash is stable and ignores the encoder', () => {
    expect(hlsProfileHash({ width: 1280 })).toBe(hlsProfileHash({ width: 1280 }))
    expect(hlsProfileHash({ width: 1280 })).not.toBe(hlsProfileHash({ width: 3840 }))
  })

  test('publishes a validated attempt directory and reports progress', async () => {
    const { cacheDir, source } = workspace()
    const seen: number[] = []
    const result = await generateHlsGeneration(source, cacheDir, {
      ...options(),
      onProgress: (percent) => seen.push(percent),
    })

    expect(result).not.toBeNull()
    expect(result!.encoder).toBe('libx264')
    expect(result!.segmentCount).toBe(3)
    expect(result!.storageRel).toBe('hls/asset1/v1/g/gen1-attempt1')
    expect(result!.playlistRel).toBe('hls/asset1/v1/g/gen1-attempt1/master.m3u8')
    const published = path.join(cacheDir, result!.storageRel)
    expect(readdirSync(published).sort()).toEqual([
      'master.m3u8',
      'seg00000.ts',
      'seg00001.ts',
      'seg00002.ts',
    ])
    expect(readdirSync(path.join(cacheDir, 'hls/asset1/v1/g')).some((name) => name.startsWith('.tmp-'))).toBe(false)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.at(-1)).toBe(80)
  })

  test('falls back to the CPU only when NVENC is unavailable', async () => {
    const { cacheDir, source } = workspace()
    setMode('nvenc-unavailable')
    const result = await generateHlsGeneration(source, cacheDir, {
      ...options(),
      hwaccel: 'nvenc',
    })
    expect(result?.encoder).toBe('libx264')
    clearMode()
  })

  test('an abort never falls back and leaves no attempt behind', async () => {
    const { cacheDir, source } = workspace()
    setMode('slow')
    const controller = new AbortController()
    const pending = generateHlsGeneration(source, cacheDir, {
      ...options(),
      hwaccel: 'nvenc',
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 150)
    await expect(pending).rejects.toBeInstanceOf(HlsAbortedError)
    const versionDir = path.join(cacheDir, 'hls/asset1/v1/g')
    expect(existsSync(versionDir) ? readdirSync(versionDir) : []).toEqual([])
    clearMode()
  })

  test('a failed publish guard removes the staging directory', async () => {
    const { cacheDir, source } = workspace()
    const result = await generateHlsGeneration(source, cacheDir, {
      ...options(),
      canPublish: () => false,
    })
    expect(result).toBeNull()
    const versionDir = path.join(cacheDir, 'hls/asset1/v1/g')
    expect(existsSync(versionDir) ? readdirSync(versionDir) : []).toEqual([])
  })

  test('rejects a segment that is not a whole MPEG-TS file', async () => {
    const { cacheDir, source } = workspace()
    setMode('bad-segment')
    await expect(generateHlsGeneration(source, cacheDir, options())).rejects.toThrow(
      /MPEG-TS/,
    )
    clearMode()
  })

  test('rejects a playlist without the required structure', async () => {
    const { cacheDir, source } = workspace()
    setMode('bad-playlist')
    await expect(generateHlsGeneration(source, cacheDir, options())).rejects.toThrow(
      /#EXTM3U/,
    )
    clearMode()
  })

  test('recognizes hardware failures and not input failures', () => {
    expect(isNvencUnavailable('Cannot load libnvidia-encode.so.1')).toBe(true)
    expect(isNvencUnavailable('No capable devices found')).toBe(true)
    expect(isNvencUnavailable('Invalid data found when processing input')).toBe(false)
  })
})

describe('bounded ffmpeg execution', () => {
  test('a stuck encoder is killed at the wall clock', async () => {
    setMode('slow')
    const { cacheDir, source } = workspace()
    const outDir = path.join(cacheDir, 'encode')
    mkdirSync(outDir, { recursive: true })
    const started = Date.now()

    const failure = await runFfmpeg(
      source,
      outDir,
      { hwaccel: null, width: 1280, durationMs: 10_000 },
      'libx264',
      { progress: false, timeoutMs: 400, stallTimeoutMs: 0 },
    ).catch((error) => error)

    expect(failure).toBeInstanceOf(ProcessTimeoutError)
    expect(Date.now() - started).toBeLessThan(5_000)
    clearMode()
  })

  test('an abort stops the encoder without waiting for the budget', async () => {
    setMode('slow')
    const { cacheDir, source } = workspace()
    const outDir = path.join(cacheDir, 'encode')
    mkdirSync(outDir, { recursive: true })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const started = Date.now()

    const failure = await runFfmpeg(
      source,
      outDir,
      { hwaccel: null, width: 1280, durationMs: 10_000, signal: controller.signal },
      'libx264',
      { progress: false, timeoutMs: 60_000, stallTimeoutMs: 0 },
    ).catch((error) => error)

    expect(failure).toBeInstanceOf(HlsAbortedError)
    expect(Date.now() - started).toBeLessThan(5_000)
    clearMode()
  })

  test('a timeout takes down a helper the encoder spawned', async () => {
    const childPidFile = path.join(tmpdir(), 'mv-fake-ffmpeg.child')
    rmSync(childPidFile, { force: true })
    setMode('tree')
    const { cacheDir, source } = workspace()
    const outDir = path.join(cacheDir, 'encode')
    mkdirSync(outDir, { recursive: true })

    const failure = await runFfmpeg(
      source,
      outDir,
      { hwaccel: null, width: 1280, durationMs: 10_000 },
      'libx264',
      { progress: false, timeoutMs: 1_500, stallTimeoutMs: 0 },
    ).catch((error) => error)

    expect(failure).toBeInstanceOf(ProcessTimeoutError)
    const childPid = Number(readFileSync(childPidFile, 'utf8'))
    expect(Number.isInteger(childPid)).toBe(true)

    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && processAlive(childPid)) await Bun.sleep(50)
    expect(processAlive(childPid)).toBe(false)
    clearMode()
  })
})

function processAlive(pid: number): boolean {
  const result = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)])
  const state = result.stdout.toString().trim()
  return state !== '' && !state.startsWith('Z')
}
