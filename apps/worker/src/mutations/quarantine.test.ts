import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  QUARANTINE_DIR,
  isCrossDeviceRename,
  parseMountInfo,
  planQuarantine,
  quarantineAbs,
  resolveMountRoot,
} from './quarantine'

const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function makeMediaRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-quarantine-'))
  dirs.push(dir)
  return dir
}

describe('mountinfo quarantine placement', () => {
  test('parses mount points and unescapes octal sequences', () => {
    const text = [
      '22 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw',
      '23 1 8:2 / /media rw,relatime - ext4 /dev/sdb1 rw',
      '24 1 8:3 / /media/extra rw,relatime - ext4 /dev/sdc1 rw',
      '25 1 8:4 / /media/My\\040Drive rw,relatime - ext4 /dev/sdd1 rw',
    ].join('\n')
    expect(parseMountInfo(text)).toEqual(['/', '/media', '/media/extra', '/media/My Drive'])
  })

  test('picks the longest mount that contains both the file and the media root', async () => {
    const mediaRoot = await makeMediaRoot()
    const targetDir = path.join(mediaRoot, 'extra', 'd', 'Lib')
    await mkdir(targetDir, { recursive: true })

    const mountPoints = ['/', mediaRoot, path.join(mediaRoot, 'extra'), path.join(mediaRoot, 'other')]
    expect(await resolveMountRoot(targetDir, mediaRoot, mountPoints)).toBe(
      path.join(mediaRoot, 'extra'),
    )
  })

  test('ignores mounts outside the media root and falls back to the device walk', async () => {
    const mediaRoot = await makeMediaRoot()
    const targetDir = path.join(mediaRoot, 'Lib')
    await mkdir(targetDir, { recursive: true })

    // Neither point is inside the media root, so the walk owns the decision.
    const outside = await resolveMountRoot(targetDir, mediaRoot, ['/', '/mnt/elsewhere'])
    expect(outside).toBe(path.resolve(mediaRoot))
  })

  test('creates a private quarantine directory on the resolved mount', async () => {
    const mediaRoot = await makeMediaRoot()
    const libraryDir = path.join(mediaRoot, 'Lib')
    await mkdir(libraryDir, { recursive: true })
    const source = path.join(libraryDir, 'clip.mp4')
    await writeFile(source, 'x')

    const plan = await planQuarantine(source, mediaRoot, 'm1', [mediaRoot])
    expect(plan).not.toBeNull()
    expect(plan!.root).toBe(mediaRoot)
    expect(plan!.rel).toBe(`${QUARANTINE_DIR}/m1/clip.mp4`)
    expect(plan!.abs).toBe(path.join(mediaRoot, QUARANTINE_DIR, 'm1', 'clip.mp4'))
    const info = await stat(path.join(mediaRoot, QUARANTINE_DIR))
    expect(info.isDirectory()).toBe(true)
    if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o700)
  })

  test('refuses a quarantine directory that is a symlink', async () => {
    const mediaRoot = await makeMediaRoot()
    const libraryDir = path.join(mediaRoot, 'Lib')
    await mkdir(libraryDir, { recursive: true })
    const source = path.join(libraryDir, 'clip.mp4')
    await writeFile(source, 'x')
    const elsewhere = path.join(mediaRoot, 'elsewhere')
    await mkdir(elsewhere)
    await symlink(elsewhere, path.join(mediaRoot, QUARANTINE_DIR))

    expect(await planQuarantine(source, mediaRoot, 'm1', [mediaRoot])).toBeNull()
  })

  test('quarantineAbs keeps paths inside the root', () => {
    expect(quarantineAbs('/media', 'q/m1/clip.mp4')).toBe(path.join('/media', 'q/m1/clip.mp4'))
    expect(quarantineAbs('/media', '../escape.mp4')).toBeNull()
    expect(quarantineAbs('/media', '')).toBeNull()
  })

  test('recognizes EXDEV and nothing else as a cross-device rename', () => {
    expect(isCrossDeviceRename(Object.assign(new Error('x'), { code: 'EXDEV' }))).toBe(true)
    expect(isCrossDeviceRename(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe(false)
    expect(isCrossDeviceRename(null)).toBe(false)
    expect(isCrossDeviceRename('EXDEV')).toBe(false)
  })
})
