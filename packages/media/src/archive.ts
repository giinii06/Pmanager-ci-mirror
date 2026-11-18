import type { Dirent } from 'node:fs'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { createExtractorFromFile, UnrarError } from 'node-unrar-js'
import { classifyFile } from '@mediavault/shared'
import { convertImageToJpeg95, ensureWebCompatibleVideo } from './convert'
import { uniqueDestPath } from './paths'

const runExec = promisify(execFile)

export const ARCHIVE_PASSWORDS = ['', 'misskon.com', 'mrcong.com'] as const

const TEMP_DOWNLOAD_SUFFIXES = ['.crdownload', '.part', '.tmp', '.download', '.!ut', '.partial']
const JUNK_ENTRY_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

export interface DiscoveredArchiveSet {
  primaryPath: string
  volumes: string[]
  signature: string
}

export interface ProcessArchiveOptions {
  primaryPath: string
  volumes: string[]
  hwaccel?: 'nvenc' | null
  signal?: AbortSignal
  onPhase?: (phase: 'extracting' | 'converting') => void
  withVideoGpuLease?: <T>(fn: (hwaccel: 'nvenc' | null, signal?: AbortSignal) => Promise<T>) => Promise<T>
}

export interface ProcessArchiveResult {
  status: 'completed' | 'failed_password'
  passwordUsed: string | null
  extractedFiles: number
  convertedImages: number
  convertedVideos: number
  errorMessage: string | null
}

export function isTempDownloadFile(filename: string): boolean {
  const lower = filename.toLowerCase()
  return TEMP_DOWNLOAD_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

function hasBlockingTempFile(filenames: string[], baseStem: string): boolean {
  const lowerStem = baseStem.toLowerCase()
  return filenames.some((name) => {
    if (!isTempDownloadFile(name)) return false
    return name.toLowerCase().includes(lowerStem)
  })
}

async function computeSignature(volumes: string[]): Promise<string | null> {
  const parts: string[] = []
  for (const volume of volumes) {
    try {
      const info = await stat(volume)
      if (!info.isFile()) return null
      parts.push(`${path.basename(volume)}:${info.size}:${Math.round(info.mtimeMs)}`)
    } catch {
      return null
    }
  }
  return parts.join('|')
}

export async function discoverArchiveSetsFromEntries(
  dir: string,
  entries: Dirent[],
): Promise<DiscoveredArchiveSet[]> {
  const filenames = entries.filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name)
  const hasCandidate = filenames.some((name) => /\.(rar|r\d{2,})$/i.test(name))
  if (!hasCandidate) return []

  const partGroups = new Map<string, Array<{ part: number; abs: string }>>()
  const legacySides = new Map<string, Array<{ index: number; abs: string }>>()
  const plainRars: Array<{ stem: string; abs: string }> = []

  for (const name of filenames) {
    const abs = path.join(dir, name)
    const partMatch = /^(.*)\.part0*(\d+)\.rar$/i.exec(name)
    if (partMatch && partMatch[1] && partMatch[2]) {
      const key = path.join(dir, partMatch[1].toLowerCase())
      const list = partGroups.get(key) ?? []
      list.push({ part: Number(partMatch[2]), abs })
      partGroups.set(key, list)
      continue
    }

    const legacyMatch = /^(.*)\.r(\d{2,})$/i.exec(name)
    if (legacyMatch && legacyMatch[1] && legacyMatch[2]) {
      const key = path.join(dir, legacyMatch[1].toLowerCase())
      const list = legacySides.get(key) ?? []
      list.push({ index: Number(legacyMatch[2]), abs })
      legacySides.set(key, list)
      continue
    }

    if (/\.rar$/i.test(name)) {
      const stem = name.slice(0, -4)
      plainRars.push({ stem, abs })
    }
  }

  const sets: DiscoveredArchiveSet[] = []

  for (const [, parts] of partGroups) {
    parts.sort((a, b) => a.part - b.part)
    const first = parts[0]
    if (!first || first.part !== 1) continue
    const contiguous = parts.every((p, idx) => p.part === idx + 1)
    if (!contiguous) continue
    const stem = path.basename(first.abs).replace(/\.part0*\d+\.rar$/i, '')
    if (hasBlockingTempFile(filenames, stem)) continue
    const volumes = parts.map((p) => p.abs)
    const signature = await computeSignature(volumes)
    if (signature) sets.push({ primaryPath: first.abs, volumes, signature })
  }

  for (const plain of plainRars) {
    if (hasBlockingTempFile(filenames, plain.stem)) continue
    const key = path.join(dir, plain.stem.toLowerCase())
    const sides = (legacySides.get(key) ?? []).sort((a, b) => a.index - b.index).map((s) => s.abs)
    const volumes = [plain.abs, ...sides]
    const signature = await computeSignature(volumes)
    if (signature) sets.push({ primaryPath: plain.abs, volumes, signature })
  }

  return sets.sort((a, b) => a.primaryPath.localeCompare(b.primaryPath))
}

export async function discoverArchiveSetsInDir(dir: string): Promise<DiscoveredArchiveSet[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return discoverArchiveSetsFromEntries(dir, entries)
}

export async function waitForArchiveStability(
  volumes: string[],
  opts: { stableMs?: number; pollMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  if (volumes.length === 0) throw new Error('archive volume list is empty')
  const stableMs = opts.stableMs ?? 1_500
  const pollMs = opts.pollMs ?? 250
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000
  const parentDir = path.dirname(volumes[0]!)
  const stem = path
    .basename(volumes[0]!)
    .replace(/\.part0*\d+\.rar$/i, '')
    .replace(/\.rar$/i, '')

  const start = Date.now()
  let lastSig: string | null = null
  let stableSince = start

  while (Date.now() - start <= timeoutMs) {
    const dirNames = (await readdir(parentDir)).filter((name) => !name.startsWith('.'))
    if (hasBlockingTempFile(dirNames, stem)) {
      lastSig = null
      stableSince = Date.now()
      await Bun.sleep(pollMs)
      continue
    }

    const sig = await computeSignature(volumes)
    if (!sig) {
      throw new Error(`archive volume disappeared while stabilizing: ${volumes[0]}`)
    }
    if (sig === lastSig) {
      if (Date.now() - stableSince >= stableMs) return
    } else {
      lastSig = sig
      stableSince = Date.now()
    }
    await Bun.sleep(pollMs)
  }

  throw new Error(`timed out waiting for archive to finish downloading: ${volumes[0]}`)
}

export function sanitizeArchiveEntryPath(rawPath: string): string {
  if (rawPath.includes('\0')) throw new Error(`unsafe archive entry (null byte): ${rawPath}`)
  const normalized = rawPath.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`unsafe archive entry (absolute path): ${rawPath}`)
  }
  const parts = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (parts.some((segment) => segment === '..')) {
    throw new Error(`unsafe archive entry (path traversal): ${rawPath}`)
  }
  return parts.join('/')
}

class ArchivePasswordError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchivePasswordError'
  }
}

let cachedHasUnar: boolean | null = null
async function hasUnarCli(): Promise<boolean> {
  if (cachedHasUnar !== null) return cachedHasUnar
  try {
    await runExec('unar', ['-version'], { timeout: 3_000 })
    cachedHasUnar = true
  } catch {
    cachedHasUnar = false
  }
  return cachedHasUnar
}

async function tryExtractWithUnarCli(
  primaryPath: string,
  attemptDir: string,
  password: string,
): Promise<void> {
  // Inspect archive listing first to reject path traversal entries before extraction.
  try {
    const { stdout } = await runExec(
      'lsar',
      ['-json', ...(password ? ['-password', password] : ['-password', '']), primaryPath],
      { maxBuffer: 16 * 1024 * 1024 },
    )
    const parsed = JSON.parse(stdout) as { lsarContents?: Array<{ XADFileName?: string }> }
    for (const item of parsed.lsarContents ?? []) {
      if (item.XADFileName) sanitizeArchiveEntryPath(item.XADFileName)
    }
  } catch (error) {
    const text = `${(error as Error).message} ${(error as { stderr?: string }).stderr ?? ''}`.toLowerCase()
    if (text.includes('password') || text.includes('encrypted') || text.includes('decryption')) {
      throw new ArchivePasswordError('Archive requires a different password')
    }
    throw error
  }

  try {
    await runExec(
      'unar',
      [
        '-no-directory',
        '-force-overwrite',
        '-output-directory',
        attemptDir,
        '-password',
        password,
        primaryPath,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    )
  } catch (error) {
    const text = `${(error as Error).message} ${(error as { stderr?: string }).stderr ?? ''}`.toLowerCase()
    if (
      text.includes('password') ||
      text.includes('decryption') ||
      text.includes('checksum') ||
      text.includes('encrypted')
    ) {
      throw new ArchivePasswordError('Archive password failed')
    }
    throw error
  }
}

async function tryExtractWithWasm(
  primaryPath: string,
  attemptDir: string,
  password: string,
): Promise<void> {
  let knownEncrypted = false
  try {
    const inspector = await createExtractorFromFile({
      filepath: primaryPath,
      targetPath: attemptDir,
      password: password || undefined,
      filenameTransform: sanitizeArchiveEntryPath,
    })
    const list = inspector.getFileList()
    if (list.arcHeader.flags.headerEncrypted) knownEncrypted = true
    try {
      for (const header of list.fileHeaders) {
        sanitizeArchiveEntryPath(header.name)
        if (header.flags.encrypted) knownEncrypted = true
      }
    } finally {
      list.fileHeaders.return?.(undefined)
    }

    const extractor = await createExtractorFromFile({
      filepath: primaryPath,
      targetPath: attemptDir,
      password: password || undefined,
      filenameTransform: sanitizeArchiveEntryPath,
    })
    const extracted = extractor.extract({ password: password || undefined })
    try {
      for (const item of extracted.files) {
        if (item.fileHeader.flags.encrypted) knownEncrypted = true
        sanitizeArchiveEntryPath(item.fileHeader.name)
      }
    } finally {
      extracted.files.return?.(undefined)
    }
  } catch (error) {
    if (error instanceof UnrarError) {
      if (
        error.reason === 'ERAR_MISSING_PASSWORD' ||
        error.reason === 'ERAR_BAD_PASSWORD' ||
        (error.reason === 'ERAR_BAD_DATA' && knownEncrypted)
      ) {
        throw new ArchivePasswordError(error.message)
      }
    }
    throw error
  }
}

async function listSafeFiles(dir: string, relBase = ''): Promise<Array<{ abs: string; rel: string }>> {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: Array<{ abs: string; rel: string }> = []
  for (const entry of entries) {
    if (entry.name === '__MACOSX' || JUNK_ENTRY_NAMES.has(entry.name.toLowerCase())) continue
    const abs = path.join(dir, entry.name)
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...(await listSafeFiles(abs, rel)))
    } else if (entry.isFile()) {
      out.push({ abs, rel })
    }
  }
  return out
}

export async function extractAndProcessArchive(
  options: ProcessArchiveOptions,
): Promise<ProcessArchiveResult> {
  const unarAvailable = await hasUnarCli()
  if (options.volumes.length > 1 && !unarAvailable) {
    throw new Error('Multi-volume RAR extraction requires the unar CLI tool')
  }

  const destDir = path.dirname(options.primaryPath)
  const stagingRoot = await mkdtemp(path.join(destDir, '.mv-extract-'))

  try {
    options.onPhase?.('extracting')
    let matchedPassword: string | null = null
    let lastPasswordErr: unknown = null

    for (const password of ARCHIVE_PASSWORDS) {
      const attemptDir = await mkdtemp(path.join(stagingRoot, 'try-'))
      try {
        if (unarAvailable) {
          await tryExtractWithUnarCli(options.primaryPath, attemptDir, password)
        } else {
          await tryExtractWithWasm(options.primaryPath, attemptDir, password)
        }
        matchedPassword = password
        const topEntries = await readdir(attemptDir)
        for (const name of topEntries) {
          await rename(path.join(attemptDir, name), path.join(stagingRoot, name))
        }
        await rm(attemptDir, { recursive: true, force: true })
        break
      } catch (error) {
        await rm(attemptDir, { recursive: true, force: true })
        if (error instanceof ArchivePasswordError) {
          lastPasswordErr = error
          continue
        }
        throw error
      }
    }

    if (matchedPassword === null) {
      return {
        status: 'failed_password',
        passwordUsed: null,
        extractedFiles: 0,
        convertedImages: 0,
        convertedVideos: 0,
        errorMessage:
          lastPasswordErr instanceof Error
            ? lastPasswordErr.message
            : 'Archive password did not match any configured password',
      }
    }

    options.onPhase?.('converting')
    const stagedFiles = await listSafeFiles(stagingRoot)
    let convertedImages = 0
    let convertedVideos = 0
    const finalRelPaths: Array<{ abs: string; rel: string }> = []

    for (const entry of stagedFiles) {
      const type = classifyFile(entry.abs)
      if (type?.kind === 'image') {
        const res = await convertImageToJpeg95(entry.abs)
        if (res.converted) convertedImages += 1
        finalRelPaths.push({ abs: res.outputPath, rel: path.relative(stagingRoot, res.outputPath) })
      } else if (type?.kind === 'video') {
        const res = options.withVideoGpuLease
          ? await options.withVideoGpuLease((hwaccel, sig) =>
              ensureWebCompatibleVideo(entry.abs, { hwaccel, signal: sig }),
            )
          : await ensureWebCompatibleVideo(entry.abs, {
              hwaccel: options.hwaccel,
              signal: options.signal,
            })
        if (res.transcoded) convertedVideos += 1
        finalRelPaths.push({ abs: res.outputPath, rel: path.relative(stagingRoot, res.outputPath) })
      } else {
        finalRelPaths.push(entry)
      }
    }

    for (const item of finalRelPaths) {
      const safeRel = sanitizeArchiveEntryPath(item.rel)
      const parsed = path.parse(path.join(destDir, safeRel))
      const destPath = await uniqueDestPath(parsed.dir, parsed.name, parsed.ext)
      await mkdir(path.dirname(destPath), { recursive: true })
      await rename(item.abs, destPath)
    }

    for (const volume of options.volumes) {
      try {
        await unlink(volume)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }

    return {
      status: 'completed',
      passwordUsed: matchedPassword,
      extractedFiles: finalRelPaths.length,
      convertedImages,
      convertedVideos,
      errorMessage: null,
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}
