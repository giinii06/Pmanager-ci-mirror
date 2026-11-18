import type { Stats } from 'node:fs'
import { lstat, readdir, realpath, stat, statfs } from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { resolveInside } from '@mediavault/media'
import type { HostBrowseResponseDTO, HostDriveDTO, HostFolderEntryDTO } from '@mediavault/shared'
import type { AppContext } from '../context'
import { parseInput } from '../validate'

const DRIVE_LETTERS = ['c', 'd', 'e'] as const

const BLOCKED_SYSTEM_SEGMENTS = new Set([
  '$recycle.bin',
  'system volume information',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'recovery',
  'perflogs',
  'msocache',
  'config.msi',
  'boot',
  'documents and settings',
])

const browseQuery = z.object({
  path: z.string().max(1024).optional().default(''),
  q: z.string().trim().max(120).optional().default(''),
})

export function isBlockedSystemRelativePath(relPosix: string): boolean {
  const segments = relPosix
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!
    if (BLOCKED_SYSTEM_SEGMENTS.has(seg)) return true
    if (seg === 'appdata' || seg === '$windows.~bt' || seg === '$windows.~ws') return true
  }
  return false
}

function normalizePosixRel(raw: string): string | null {
  if (raw.includes('\0')) return null
  if (raw.startsWith('\\\\') || raw.startsWith('//')) return null
  if (/^[a-z]:/i.test(raw)) return null
  const clean = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (clean.split('/').some((seg) => seg === '..')) return null
  return clean
}

async function readCapacity(dirPath: string): Promise<{ totalBytes: number | null; freeBytes: number | null }> {
  try {
    const fsInfo = await statfs(dirPath)
    const bsize = Number(fsInfo.bsize || fsInfo.frsize || 0)
    const total = Number(fsInfo.blocks) * bsize
    const free = Number(fsInfo.bavail) * bsize
    if (Number.isFinite(total) && total > 0 && Number.isFinite(free)) {
      return { totalBytes: total, freeBytes: Math.max(0, free) }
    }
  } catch {
    // Platform or virtual mount may not support statfs.
  }
  return { totalBytes: null, freeBytes: null }
}

async function checkDirHasChildren(dirPath: string): Promise<boolean> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    return entries.some(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !entry.name.startsWith('.') &&
        !BLOCKED_SYSTEM_SEGMENTS.has(entry.name.toLowerCase()),
    )
  } catch {
    return false
  }
}

function buildBreadcrumbs(cleanRel: string, drivesMode: boolean): Array<{ name: string; path: string }> {
  const crumbs: Array<{ name: string; path: string }> = [{ name: '내 컴퓨터', path: '' }]
  if (!cleanRel) return crumbs
  const segments = cleanRel.split('/').filter(Boolean)
  let acc = ''
  for (let idx = 0; idx < segments.length; idx += 1) {
    const seg = segments[idx]!
    acc = acc ? `${acc}/${seg}` : seg
    if (drivesMode && idx === 0 && seg === 'drives') continue
    if (drivesMode && idx === 1 && segments[0] === 'drives' && /^[a-z]$/i.test(seg)) {
      crumbs.push({ name: `${seg.toUpperCase()}:\\`, path: acc })
      continue
    }
    crumbs.push({ name: seg, path: acc })
  }
  return crumbs
}

export async function resolveSafeDirectory(
  mediaRoot: string,
  relPosix: string,
): Promise<{ abs: string; stats: Stats } | { error: string; code: number; message: string }> {
  if (isBlockedSystemRelativePath(relPosix)) {
    return {
      error: 'blocked_system_path',
      code: 403,
      message: 'System directories cannot be browsed or added.',
    }
  }
  const abs = resolveInside(mediaRoot, relPosix)
  if (!abs) {
    return { error: 'outside_media_root', code: 400, message: 'Invalid path.' }
  }
  let linkInfo: Stats
  try {
    linkInfo = await lstat(abs)
  } catch {
    return { error: 'not_found', code: 404, message: 'Directory not found.' }
  }
  if (linkInfo.isSymbolicLink()) {
    return {
      error: 'symlink_forbidden',
      code: 403,
      message: 'Symlinks and junctions are not allowed.',
    }
  }
  let real: string
  let rootReal: string
  try {
    real = await realpath(abs)
    rootReal = await realpath(mediaRoot)
  } catch {
    return { error: 'not_found', code: 404, message: 'Directory not accessible.' }
  }
  const relReal = path.relative(rootReal, real)
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
    return { error: 'outside_media_root', code: 403, message: 'Resolved path escapes root.' }
  }
  const stats = await stat(abs).catch(() => null)
  if (!stats?.isDirectory()) {
    return { error: 'not_a_directory', code: 400, message: 'Path is not a directory.' }
  }
  return { abs, stats }
}

export async function listHostDrives(mediaRoot: string): Promise<HostDriveDTO[]> {
  const drivesDir = resolveInside(mediaRoot, 'drives')
  const drives: HostDriveDTO[] = []

  if (drivesDir) {
    for (const letter of DRIVE_LETTERS) {
      const candidate = path.join(drivesDir, letter)
      try {
        const info = await stat(candidate)
        if (!info.isDirectory()) continue
        await readdir(candidate)
        const cap = await readCapacity(candidate)
        drives.push({
          id: `drive-${letter}`,
          label: `${letter.toUpperCase()}:\\`,
          rootPath: `drives/${letter}`,
          ...cap,
        })
      } catch {
        // Unmounted or absent drive slot on this host.
      }
    }
  }

  if (drives.length === 0) {
    const cap = await readCapacity(mediaRoot)
    drives.push({
      id: 'media-root',
      label: '미디어 루트 (/)',
      rootPath: '',
      ...cap,
    })
  }

  return drives
}

export function registerFsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/fs/drives', async (_request, reply) => {
    const drives = await listHostDrives(ctx.config.mediaRoot)
    reply.send({ drives })
  })

  app.get('/api/fs/browse', async (request, reply) => {
    const query = parseInput(browseQuery, request.query, reply)
    if (!query) return

    const cleanRel = normalizePosixRel(query.path)
    if (cleanRel === null) {
      reply.code(400).send({ error: 'invalid_path', message: 'Invalid directory path.' })
      return
    }

    const drives = await listHostDrives(ctx.config.mediaRoot)
    const hasDrivesMount = drives.some((d) => d.rootPath.startsWith('drives/'))
    const effectiveRel =
      cleanRel === '' && hasDrivesMount ? 'drives' : cleanRel

    if (effectiveRel === 'drives' && hasDrivesMount) {
      const needle = query.q.toLowerCase()
      const folders: HostFolderEntryDTO[] = drives
        .filter((d) => !needle || d.label.toLowerCase().includes(needle))
        .map((d) => ({
          name: d.label,
          path: d.rootPath,
          hasChildren: true,
          modifiedAt: null,
        }))
      const payload: HostBrowseResponseDTO = {
        currentPath: '',
        parentPath: null,
        breadcrumbs: [{ name: '내 컴퓨터', path: '' }],
        folders,
      }
      reply.send(payload)
      return
    }

    const resolved = await resolveSafeDirectory(ctx.config.mediaRoot, effectiveRel)
    if ('error' in resolved) {
      reply.code(resolved.code).send({ error: resolved.error, message: resolved.message })
      return
    }

    let entries
    try {
      entries = await readdir(resolved.abs, { withFileTypes: true })
    } catch {
      reply.code(403).send({ error: 'permission_denied', message: 'Cannot open directory.' })
      return
    }

    const needle = query.q.toLowerCase()
    const candidateDirs = entries.filter((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) {
        return false
      }
      const lower = entry.name.toLowerCase()
      if (isBlockedSystemRelativePath(lower)) return false
      if (effectiveRel === '' && (lower === 'drives' || lower === 'extra')) return false
      if (needle && !lower.includes(needle)) return false
      return true
    })

    candidateDirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

    const folders: HostFolderEntryDTO[] = await Promise.all(
      candidateDirs.map(async (entry) => {
        const childAbs = path.join(resolved.abs, entry.name)
        const childRel = effectiveRel === '' ? entry.name : `${effectiveRel}/${entry.name}`
        let modifiedAt: string | null = null
        try {
          modifiedAt = new Date((await stat(childAbs)).mtimeMs).toISOString()
        } catch {
          modifiedAt = null
        }
        return {
          name: entry.name,
          path: childRel,
          hasChildren: await checkDirHasChildren(childAbs),
          modifiedAt,
        }
      }),
    )

    const segments = effectiveRel.split('/').filter(Boolean)
    let parentPath: string | null = null
    if (hasDrivesMount) {
      if (segments.length === 2 && segments[0] === 'drives') parentPath = ''
      else if (segments.length > 2) parentPath = segments.slice(0, -1).join('/')
    } else if (segments.length > 0) {
      parentPath = segments.slice(0, -1).join('/')
    }

    const response: HostBrowseResponseDTO = {
      currentPath: effectiveRel,
      parentPath,
      breadcrumbs: buildBreadcrumbs(effectiveRel, hasDrivesMount),
      folders,
    }
    reply.send(response)
  })
}
