#!/usr/bin/env bun
/**
 * Test double for ffmpeg. It writes a small but structurally valid MPEG-TS
 * playlist, or fails in the specific way a test needs, without a real encoder.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const modeFile = path.join(tmpdir(), 'mv-fake-ffmpeg.mode')
const mode = existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : 'ok'

function valueAfter(flag: string): string | null {
  const index = args.indexOf(flag)
  return index >= 0 ? (args[index + 1] ?? null) : null
}

if (args.includes('h264_nvenc') && mode === 'nvenc-unavailable') {
  process.stderr.write('Cannot load libnvidia-encode.so.1\n')
  process.exit(1)
}

const segmentPattern = valueAfter('-hls_segment_filename')
const playlist = args[args.length - 1]
if (!segmentPattern || !playlist) {
  process.stderr.write('fake ffmpeg: missing output arguments\n')
  process.exit(2)
}

const dir = path.dirname(segmentPattern)
mkdirSync(dir, { recursive: true })
const count = 3
for (let index = 0; index < count; index += 1) {
  const size = mode === 'bad-segment' ? 100 : 376
  const packet = Buffer.alloc(size, 0)
  packet[0] = 0x47
  writeFileSync(segmentPattern.replace('%05d', String(index).padStart(5, '0')), packet)
}

if (mode === 'bad-playlist') {
  writeFileSync(playlist, 'not a playlist')
  process.exit(0)
}

const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD']
for (let index = 0; index < count; index += 1) {
  lines.push('#EXTINF:4.000,', `seg${String(index).padStart(5, '0')}.ts`)
}
lines.push('#EXT-X-ENDLIST', '')
writeFileSync(playlist, lines.join('\n'))

if (args.includes('-progress')) {
  process.stdout.write('out_time_us=2000000\nprogress=continue\n')
  process.stdout.write('out_time_us=8000000\nprogress=continue\n')
}
if (mode === 'slow') {
  await Bun.sleep(30_000)
}
if (args.includes('-progress')) process.stdout.write('progress=end\n')
