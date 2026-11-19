import path from 'node:path'
import { lstat, mkdir, readFile } from 'node:fs/promises'

/** Hidden from the scanner, which skips every entry whose name starts with '.'. */
export const QUARANTINE_DIR = '.mediavault-quarantine'

export interface QuarantinePlan {
  /** Absolute container path of the mount that holds the source file. */
  root: string
  /** Quarantine path relative to `root`, stored in the database. */
  rel: string
  /** Absolute quarantine path. */
  abs: string
}

function unescapeMountPath(raw: string): string {
  return raw.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  )
}

/** `/proc/self/mountinfo` keeps spaces in mount points escaped, so fields stay split-safe. */
export function parseMountInfo(text: string): string[] {
  const points: string[] = []
  for (const line of text.split('\n')) {
    const fields = line.trim().split(' ')
    if (fields.length < 5) continue
    const point = fields[4]
    if (!point) continue
    points.push(unescapeMountPath(point))
  }
  return points
}

async function readMountPoints(): Promise<string[]> {
  try {
    return parseMountInfo(await readFile('/proc/self/mountinfo', 'utf8'))
  } catch {
    return []
  }
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep)
}

/**
 * Picks the mount that actually holds the source file. Two bind mounts of the
 * same disk report the same `st_dev`, yet `rename(2)` returns EXDEV between
 * them, so the mount point from mountinfo is the only reliable boundary.
 */
export async function resolveMountRoot(
  targetDir: string,
  mediaRoot: string,
  mountPoints?: string[],
): Promise<string | null> {
  const points = mountPoints ?? (await readMountPoints())
  const root = path.resolve(mediaRoot)
  let best: string | null = null
  for (const point of points) {
    if (!isWithin(targetDir, point)) continue
    if (!isWithin(point, root)) continue
    if (best === null || point.length > best.length) best = point
  }
  if (best !== null) return best

  // No /proc (or no matching entry): fall back to the device walk, bounded by
  // the media root. The rename itself is the real proof either way.
  let current = targetDir
  let device: number
  try {
    device = (await lstat(current)).dev
  } catch {
    return null
  }
  while (isWithin(current, root) && current !== root) {
    const parent = path.dirname(current)
    if (!isWithin(parent, root)) break
    try {
      if ((await lstat(parent)).dev !== device) break
    } catch {
      break
    }
    current = parent
  }
  return current
}

/**
 * Plans a same-filesystem quarantine location and creates the quarantine root.
 * Returns null when no writable location on that mount exists; the caller must
 * refuse the delete rather than copy across devices.
 */
export async function planQuarantine(
  sourceAbs: string,
  mediaRoot: string,
  mutationId: string,
  mountPoints?: string[],
): Promise<QuarantinePlan | null> {
  const sourceDir = path.dirname(sourceAbs)
  const root = await resolveMountRoot(sourceDir, mediaRoot, mountPoints)
  if (!root) return null
  const quarantineRoot = path.join(root, QUARANTINE_DIR)
  try {
    const info = await lstat(quarantineRoot)
    if (info.isSymbolicLink() || !info.isDirectory()) return null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
    try {
      await mkdir(quarantineRoot, { recursive: true, mode: 0o700 })
    } catch {
      return null
    }
  }
  const abs = path.join(quarantineRoot, mutationId, path.basename(sourceAbs))
  return { root, rel: path.relative(root, abs).split(path.sep).join('/'), abs }
}

export function quarantineAbs(root: string, rel: string): string | null {
  const base = path.resolve(root)
  const target = path.resolve(base, rel)
  if (!isWithin(target, base) || target === base) return null
  return target
}

/**
 * `rename(2)` reports EXDEV when the two paths sit on different filesystems,
 * including two bind mounts of the same disk. A delete must never fall back to
 * a copy: the original would be destroyed before the copy is proven.
 */
export function isCrossDeviceRename(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'EXDEV'
  )
}
