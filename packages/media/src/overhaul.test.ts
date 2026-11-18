import { afterAll, describe, expect, test } from 'bun:test'
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import {
  convertImageToJpeg95,
  discoverArchiveSetsInDir,
  ensureWebCompatibleVideo,
  extractAndProcessArchive,
  extractCustomVideoPoster,
  posterPath,
  probeVideo,
  sanitizeArchiveEntryPath,
  waitForArchiveStability,
} from './index'

const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (const b of buf) {
    c ^= b
    for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0)
  }
  return (c ^ 0xffffffff) >>> 0
}

function buildRar4(
  files: Array<{ name: string; data: Uint8Array; encrypted?: boolean }>,
): Uint8Array {
  const chunks: Uint8Array[] = [Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])]
  const mhd = new Uint8Array(13)
  mhd[2] = 0x73
  mhd[5] = 13
  const mcrc = crc32(mhd.subarray(2)) & 0xffff
  mhd[0] = mcrc & 0xff
  mhd[1] = (mcrc >> 8) & 0xff
  chunks.push(mhd)

  for (const f of files) {
    const nameBytes = Buffer.from(f.name, 'utf8')
    const hdr = new Uint8Array(32 + nameBytes.length)
    const dv = new DataView(hdr.buffer)
    hdr[2] = 0x74
    dv.setUint16(3, f.encrypted ? 0x8004 : 0x8000, true)
    dv.setUint16(5, hdr.length, true)
    dv.setUint32(7, f.data.length, true)
    dv.setUint32(11, f.data.length, true)
    hdr[15] = 0x03
    dv.setUint32(16, crc32(f.data), true)
    hdr[24] = 29
    hdr[25] = 0x30
    dv.setUint16(26, nameBytes.length, true)
    hdr.set(nameBytes, 32)
    dv.setUint16(0, crc32(hdr.subarray(2)) & 0xffff, true)
    chunks.push(hdr, f.data)
  }
  chunks.push(Uint8Array.from([0xc4, 0x3d, 0x7b, 0x00, 0x40, 0x07, 0x00]))
  return Buffer.concat(chunks)
}

describe('image JPEG 95 conversion', () => {
  test('converts PNG to JPEG quality 95, verifies decode, and removes PNG source', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mv-img-'))
    dirs.push(dir)
    const srcPng = path.join(dir, 'sample.png')
    await sharp({
      create: { width: 64, height: 48, channels: 4, background: { r: 20, g: 120, b: 220, alpha: 0.5 } },
    })
      .png()
      .toFile(srcPng)

    const res = await convertImageToJpeg95(srcPng)
    expect(res.converted).toBe(true)
    expect(res.outputPath).toBe(path.join(dir, 'sample.jpg'))
    expect(await exists(res.outputPath)).toBe(true)
    expect(await exists(srcPng)).toBe(false)

    const meta = await sharp(res.outputPath).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBe(64)
    expect(meta.height).toBe(48)
  })

  test('preserves corrupt source file when image decoding fails', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mv-img-bad-'))
    dirs.push(dir)
    const badPng = path.join(dir, 'broken.png')
    await writeFile(badPng, 'not-an-image')

    await expect(convertImageToJpeg95(badPng)).rejects.toThrow()
    expect(await exists(badPng)).toBe(true)
  })
})

describe('video conversion and custom poster capture', () => {
  test('transcodes non-H264 MKV to verified H.264/AAC MP4 and removes source', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mv-vid-'))
    dirs.push(dir)
    const srcMkv = path.join(dir, 'clip.mkv')

    const gen = Bun.spawnSync([
      'ffmpeg',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=green:s=160x120:r=10:d=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:v',
      'mpeg4',
      '-c:a',
      'pcm_s16le',
      srcMkv,
    ])
    if (gen.exitCode !== 0) throw new Error(gen.stderr.toString())

    const res = await ensureWebCompatibleVideo(srcMkv, { hwaccel: 'nvenc' })
    expect(res.transcoded).toBe(true)
    expect(res.outputPath).toBe(path.join(dir, 'clip.mp4'))
    expect(await exists(res.outputPath)).toBe(true)
    expect(await exists(srcMkv)).toBe(false)

    const probed = await probeVideo(res.outputPath, 1)
    expect(probed.videoCodec).toBe('h264')
    expect(probed.pixFmt).toBe('yuv420p')
    expect(probed.audioCodec).toBe('aac')
    expect(probed.durationMs).toBeGreaterThan(1_000)

    const repeat = await ensureWebCompatibleVideo(res.outputPath)
    expect(repeat.transcoded).toBe(false)
  })

  test('extractCustomVideoPoster replaces poster at paused timestamp without modifying video', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mv-custom-poster-'))
    dirs.push(dir)
    const video = path.join(dir, 'fade.mp4')
    const cacheDir = path.join(dir, 'cache')

    const gen = Bun.spawnSync([
      'ffmpeg',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=160x120:r=10:d=2',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=160x120:r=10:d=2',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]',
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      video,
    ])
    if (gen.exitCode !== 0) throw new Error(gen.stderr.toString())

    const beforeStat = await stat(video)
    await extractCustomVideoPoster(video, cacheDir, 'customvid1', 1, 3_000)
    const afterStat = await stat(video)
    expect(afterStat.size).toBe(beforeStat.size)

    const poster320 = posterPath(cacheDir, 'customvid1', 1, 320)
    const { data } = await sharp(poster320).raw().toBuffer({ resolveWithObject: true })
    expect(data[0]!).toBeGreaterThan(180)
    expect(data[1]!).toBeLessThan(60)
  })
})

describe('RAR archive discovery, security, and extraction', () => {
  test('rejects path traversal entries safely', () => {
    expect(() => sanitizeArchiveEntryPath('../evil.jpg')).toThrow()
    expect(() => sanitizeArchiveEntryPath('/etc/passwd')).toThrow()
    expect(() => sanitizeArchiveEntryPath('C:\\bad\\a.jpg')).toThrow()
    expect(sanitizeArchiveEntryPath('sub\\001.jpg')).toBe('sub/001.jpg')
  })

  test('extracts flat directly into RAR directory, converts images to JPEG 95, and deletes RAR', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mv-rar-ok-'))
    dirs.push(dir)

    const pngBuf = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 240, g: 40, b: 40 } },
    })
      .png()
      .toBuffer()

    const rarPath = path.join(dir, 'Set01.rar')
    await writeFile(rarPath, buildRar4([{ name: '001.png', data: pngBuf }]))

    const sets = await discoverArchiveSetsInDir(dir)
    expect(sets).toHaveLength(1)
    await waitForArchiveStability(sets[0]!.volumes, { stableMs: 20, pollMs: 10 })

    const res = await extractAndProcessArchive({
      primaryPath: rarPath,
      volumes: [rarPath],
    })
    expect(res.status).toBe('completed')
    expect(res.extractedFiles).toBe(1)
    expect(res.convertedImages).toBe(1)
    expect(await exists(path.join(dir, '001.jpg'))).toBe(true)
    expect(await exists(path.join(dir, 'Set01'))).toBe(false)
    expect(await exists(rarPath)).toBe(false)

    const meta = await sharp(path.join(dir, '001.jpg')).metadata()
    expect(meta.format).toBe('jpeg')
  })

  test('preserves original RAR when all configured passwords fail', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mv-rar-pw-'))
    dirs.push(dir)
    const rarPath = path.join(dir, 'Locked.rar')
    await writeFile(
      rarPath,
      buildRar4([{ name: 'secret.jpg', data: Buffer.alloc(16, 1), encrypted: true }]),
    )

    const res = await extractAndProcessArchive({
      primaryPath: rarPath,
      volumes: [rarPath],
    })
    expect(res.status).toBe('failed_password')
    expect(await exists(rarPath)).toBe(true)
    expect((await readFile(rarPath)).length).toBeGreaterThan(0)
  })

  test('throws error rather than failed_password on damaged unencrypted RAR', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mv-rar-corrupt-'))
    dirs.push(dir)
    const valid = Buffer.from(
      buildRar4([{ name: 'broken.jpg', data: Buffer.from('unencrypted-valid-payload-bytes') }]),
    )
    valid[valid.length - 12]! ^= 0xff
    const rarPath = path.join(dir, 'Broken.rar')
    await writeFile(rarPath, valid)

    await expect(
      extractAndProcessArchive({
        primaryPath: rarPath,
        volumes: [rarPath],
      }),
    ).rejects.toThrow()
    expect(await exists(rarPath)).toBe(true)
  })

  test('ignores partial multi-volume archives until all parts and no temp suffixes remain', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mv-rar-multi-'))
    dirs.push(dir)
    const p1 = path.join(dir, 'Pack.part1.rar')
    const p2Temp = path.join(dir, 'Pack.part2.rar.crdownload')
    await writeFile(p1, 'stub')
    await writeFile(p2Temp, 'downloading')

    expect(await discoverArchiveSetsInDir(dir)).toEqual([])

    await rm(p2Temp)
    const p2 = path.join(dir, 'Pack.part2.rar')
    await writeFile(p2, 'stub2')
    const sets = await discoverArchiveSetsInDir(dir)
    expect(sets).toHaveLength(1)
    expect(sets[0]?.primaryPath).toBe(p1)
    expect(sets[0]?.volumes).toEqual([p1, p2])
  })
})
