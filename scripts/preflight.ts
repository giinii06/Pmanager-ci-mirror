import { accessSync, constants, existsSync, readdirSync, realpathSync, statfsSync, statSync } from 'node:fs'
import path from 'node:path'

const GIB = 1024 ** 3

export interface PreflightPathResult {
  path: string
  required: boolean
  ok: boolean
  skipped: boolean
  realPath: string | null
  device: number | null
  freeBytes: number | null
  entries: number | null
  empty: boolean | null
  markerFound: boolean | null
  errorCode: string | null
  message: string
}

export interface PreflightReport {
  ok: boolean
  checkedAt: number
  marker: string | null
  paths: PreflightPathResult[]
  warnings: string[]
}

export interface PreflightOptions {
  paths: string[]
  requireAll?: boolean
  marker?: string | null
  requireNonEmpty?: boolean
  minFreeBytes?: number
}

export function checkPath(
  target: string,
  options: { required?: boolean; marker?: string | null; requireNonEmpty?: boolean; minFreeBytes?: number } = {},
): PreflightPathResult {
  const required = options.required ?? true
  const marker = options.marker ?? null
  const minFreeBytes = options.minFreeBytes ?? 0
  const base = {
    path: target,
    required,
    realPath: null as string | null,
    device: null as number | null,
    freeBytes: null as number | null,
    entries: null as number | null,
    empty: null as boolean | null,
    markerFound: null as boolean | null,
  }

  let info
  try {
    info = statSync(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'stat_failed'
    return {
      ...base,
      ok: !required,
      skipped: !required,
      errorCode: code,
      message: required ? `${target} does not exist (${code})` : `${target} is not mounted; skipped`,
    }
  }

  if (!info.isDirectory()) {
    return {
      ...base,
      ok: false,
      skipped: false,
      errorCode: 'not_directory',
      message: `${target} is not a directory`,
    }
  }

  try {
    base.realPath = realpathSync(target)
  } catch {
    base.realPath = path.resolve(target)
  }
  base.device = info.dev

  try {
    accessSync(target, constants.R_OK | constants.X_OK)
  } catch (error) {
    return {
      ...base,
      ok: false,
      skipped: false,
      errorCode: 'unreadable',
      message: `${target} is not readable (${(error as NodeJS.ErrnoException).code ?? 'access_failed'})`,
    }
  }

  let entries: string[]
  try {
    entries = readdirSync(target)
  } catch (error) {
    return {
      ...base,
      ok: false,
      skipped: false,
      errorCode: 'unreadable',
      message: `${target} cannot be listed (${(error as NodeJS.ErrnoException).code ?? 'readdir_failed'})`,
    }
  }
  base.entries = entries.length
  base.empty = entries.length === 0

  try {
    const fs = statfsSync(target)
    base.freeBytes = fs.bavail * fs.bsize
  } catch {
    base.freeBytes = null
  }

  if (marker !== null) {
    base.markerFound = existsSync(path.join(target, marker))
  }

  if (options.requireNonEmpty && base.empty) {
    return {
      ...base,
      ok: false,
      skipped: false,
      errorCode: 'empty',
      message: `${target} is empty; refusing to treat an empty mount as a library`,
    }
  }

  if (minFreeBytes > 0 && base.freeBytes !== null && base.freeBytes < minFreeBytes) {
    return {
      ...base,
      ok: false,
      skipped: false,
      errorCode: 'insufficient_storage',
      message: `${target} has ${formatBytes(base.freeBytes)} free, below the ${formatBytes(minFreeBytes)} minimum`,
    }
  }

  if (marker !== null && base.markerFound !== true) {
    return {
      ...base,
      ok: false,
      skipped: false,
      errorCode: 'marker_missing',
      message: `${target} is missing the safety marker ${marker}`,
    }
  }

  return {
    ...base,
    ok: true,
    skipped: false,
    errorCode: null,
    message: `${target} is readable`,
  }
}

export function runPreflight(options: PreflightOptions): PreflightReport {
  const requireAll = options.requireAll ?? false
  const paths = options.paths.map((target) =>
    checkPath(target, {
      required: requireAll,
      marker: options.marker ?? null,
      requireNonEmpty: options.requireNonEmpty ?? false,
      minFreeBytes: options.minFreeBytes ?? 0,
    }),
  )

  const warnings: string[] = []
  for (const result of paths) {
    if (result.skipped) {
      warnings.push(result.message)
      continue
    }
    if (result.empty) {
      warnings.push(`${result.path} is empty`)
    }
    if (result.freeBytes !== null && result.freeBytes < GIB) {
      warnings.push(`${result.path} has only ${formatBytes(result.freeBytes)} free`)
    }
  }

  const byDevice = new Map<number, string[]>()
  for (const result of paths) {
    if (result.device === null) continue
    const group = byDevice.get(result.device) ?? []
    group.push(result.path)
    byDevice.set(result.device, group)
  }
  for (const group of byDevice.values()) {
    if (group.length > 1) {
      warnings.push(`${group.join(' and ')} share one device; check the mount map`)
    }
  }

  return {
    ok: paths.every((result) => result.ok),
    checkedAt: Date.now(),
    marker: options.marker ?? null,
    paths,
    warnings,
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GiB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${bytes} B`
}

const DEFAULT_PATHS = ['/media', '/media/extra', '/media/drives/c', '/media/drives/d', '/media/drives/e']

function parseArgs(argv: string[]): {
  paths: string[]
  requireAll: boolean
  marker: string | null
  requireNonEmpty: boolean
  minFreeBytes: number
  json: boolean
} {
  let paths: string[] | null = null
  let requireAll = false
  let marker: string | null = null
  let requireNonEmpty = false
  let minFreeBytes = 0
  let json = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--paths') {
      paths = (argv[index + 1] ?? '').split(',').filter(Boolean)
      index += 1
    } else if (arg === '--require-all') {
      requireAll = true
    } else if (arg === '--marker') {
      marker = argv[index + 1] ?? null
      index += 1
    } else if (arg === '--require-nonempty') {
      requireNonEmpty = true
    } else if (arg === '--min-free-mb') {
      minFreeBytes = Number(argv[index + 1] ?? 0) * 1024 ** 2
      index += 1
    } else if (arg === '--json') {
      json = true
    }
  }

  return {
    paths: paths ?? DEFAULT_PATHS,
    requireAll: requireAll || paths !== null,
    marker,
    requireNonEmpty,
    minFreeBytes,
    json,
  }
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2))
  const report = runPreflight(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    const failed = report.paths.filter((result) => !result.ok).length
    console.log(`preflight: ${report.paths.length} paths, ${failed} failed, ${report.warnings.length} warnings`)
    for (const result of report.paths) {
      const state = result.ok ? (result.skipped ? 'skip' : 'ok') : 'FAIL'
      const free = result.freeBytes === null ? '-' : formatBytes(result.freeBytes)
      console.log(`  ${state.padEnd(4)} ${result.path}  free=${free}  ${result.message}`)
    }
    for (const warning of report.warnings) {
      console.log(`  warn ${warning}`)
    }
  }
  process.exit(report.ok ? 0 : 1)
}
