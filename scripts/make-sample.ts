import { mkdir, stat, utimes } from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sharp from 'sharp'

const run = promisify(execFile)

const root = path.resolve(process.argv[2] ?? process.env.SAMPLE_OUT ?? 'sample-media')

const palettes = [
  ['#8B9EFF', '#1B1E2B'],
  ['#FFB86B', '#2A1A12'],
  ['#6BE3C0', '#0E2420'],
  ['#FF8FB1', '#2A1420'],
  ['#B7A6FF', '#181428'],
  ['#8FD3FF', '#0D1A24'],
]

const ratios: Array<[number, number]> = [
  [3, 2],
  [2, 3],
  [4, 3],
  [16, 9],
  [1, 1],
]

const folders = [
  'Photos/2025/Jeju',
  'Photos/2025/Seoul',
  'Photos/2026/Seoul',
  'Photos/2026/Seoul/Night',
  'Photos/2026/Busan',
  'Videos',
]

function svgFor(index: number, width: number, height: number): string {
  const palette = palettes[index % palettes.length] ?? palettes[0]!
  const [from, to] = palette
  const angle = (index * 37) % 360
  const circleX = Math.round(width * (0.25 + ((index * 13) % 50) / 100))
  const circleY = Math.round(height * (0.3 + ((index * 7) % 40) / 100))
  const radius = Math.round(Math.min(width, height) * 0.22)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="g" gradientTransform="rotate(${angle} 0.5 0.5)">
      <stop offset="0%" stop-color="${from}"/>
      <stop offset="100%" stop-color="${to}"/>
    </linearGradient>
    <radialGradient id="v" cx="50%" cy="45%" r="70%">
      <stop offset="55%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.45"/>
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <circle cx="${circleX}" cy="${circleY}" r="${radius}" fill="#ffffff" opacity="0.14"/>
  <circle cx="${Math.round(width * 0.78)}" cy="${Math.round(height * 0.7)}" r="${Math.round(radius * 0.55)}" fill="#ffffff" opacity="0.1"/>
  <rect width="100%" height="100%" fill="url(#v)"/>
  <text x="${Math.round(width * 0.06)}" y="${Math.round(height * 0.93)}"
        font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(height * 0.075)}"
        fill="#ffffff" opacity="0.72">${String(index + 1).padStart(2, '0')}</text>
</svg>`
}

async function makeImage(index: number, destination: string, takenAt: Date): Promise<void> {
  try {
    const info = await stat(destination)
    if (info.size > 0) return
  } catch {
    // generate below
  }
  const ratio = ratios[index % ratios.length] ?? ratios[0]!
  const longEdge = [1600, 1800, 2000, 2200, 2400][index % 5] ?? 1800
  const scale = longEdge / Math.max(ratio[0], ratio[1])
  const width = Math.round(ratio[0] * scale)
  const height = Math.round(ratio[1] * scale)
  await sharp(Buffer.from(svgFor(index, width, height)))
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(destination)
  await utimes(destination, takenAt, takenAt)
}

const videoSpecs = [
  {
    file: 'Videos/coast-drive.mp4',
    args: ['-f', 'lavfi', '-i', 'gradients=s=1280x720:c0=0x8B9EFF:c1=0x0B0C0F:d=9:speed=0.08', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=9'],
    codec: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k'],
    takenAt: '2026-09-14T10:20:00Z',
  },
  {
    file: 'Videos/forest-walk.mp4',
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=7', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=7'],
    codec: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k'],
    takenAt: '2026-07-02T15:05:00Z',
  },
  {
    file: 'Videos/old-camera.mkv',
    args: ['-f', 'lavfi', '-i', 'mandelbrot=size=1280x720:rate=25', '-t', '5'],
    codec: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p'],
    takenAt: '2025-11-08T18:40:00Z',
  },
  {
    file: 'Videos/hevc-clip.mp4',
    args: ['-f', 'lavfi', '-i', 'gradients=s=1280x720:c0=0xFFB86B:c1=0x2A1A12:d=5:speed=0.1'],
    codec: ['-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1'],
    takenAt: '2026-03-21T09:12:00Z',
  },
  {
    file: 'Videos/vertical-note.mp4',
    args: ['-f', 'lavfi', '-i', 'gradients=s=720x1280:c0=0x6BE3C0:c1=0x0E2420:d=6:speed=0.06', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6'],
    codec: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k'],
    takenAt: '2026-10-05T20:30:00Z',
  },
]

async function makeVideo(spec: (typeof videoSpecs)[number]): Promise<void> {
  const destination = path.join(root, spec.file)
  try {
    const info = await stat(destination)
    if (info.size > 0) return
  } catch {
    // generate below
  }
  await run('ffmpeg', ['-v', 'error', '-y', ...spec.args, ...spec.codec, '-shortest', destination], {
    maxBuffer: 32 * 1024 * 1024,
  })
  const when = new Date(spec.takenAt)
  await utimes(destination, when, when)
}

await Promise.all(folders.map((folder) => mkdir(path.join(root, folder), { recursive: true })))

const totalImages = 56
const start = Date.UTC(2025, 8, 1)
const spanDays = 430
for (let index = 0; index < totalImages; index += 1) {
  const folder = folders[index % 5] ?? folders[0]!
  const takenAt = new Date(start + Math.floor((spanDays / totalImages) * index) * 86_400_000)
  const destination = path.join(root, folder, `IMG_${String(1000 + index)}.jpg`)
  await makeImage(index, destination, takenAt)
}

for (const spec of videoSpecs) await makeVideo(spec)

console.log(`sample library ready at ${root}`)
