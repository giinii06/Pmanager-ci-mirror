import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { checkPath, runPreflight } from './preflight'

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mv-preflight-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('preflight path checks', () => {
  test('accepts a readable directory and reports its device and free space', () => {
    const root = makeRoot()
    writeFileSync(path.join(root, 'photo.jpg'), 'x')
    const result = checkPath(root)
    expect(result.ok).toBe(true)
    expect(result.entries).toBe(1)
    expect(result.device).toBeGreaterThan(0)
    expect(result.freeBytes).toBeGreaterThan(0)
  })

  test('fails a required missing path and skips an optional one', () => {
    const missing = path.join(makeRoot(), 'missing')
    expect(checkPath(missing, { required: true })).toMatchObject({
      ok: false,
      skipped: false,
      errorCode: 'ENOENT',
    })
    expect(checkPath(missing, { required: false })).toMatchObject({
      ok: true,
      skipped: true,
    })
  })

  test('rejects a file where a directory is required', () => {
    const root = makeRoot()
    const file = path.join(root, 'not-a-dir')
    writeFileSync(file, 'x')
    expect(checkPath(file)).toMatchObject({ ok: false, errorCode: 'not_directory' })
  })

  test('refuses an empty mount when non-empty is required', () => {
    const root = makeRoot()
    expect(checkPath(root, { requireNonEmpty: true })).toMatchObject({
      ok: false,
      errorCode: 'empty',
    })
    expect(checkPath(root, { requireNonEmpty: false }).ok).toBe(true)
  })

  test('requires the safety marker when one is configured', () => {
    const root = makeRoot()
    expect(checkPath(root, { marker: '.mediavault-root' })).toMatchObject({
      ok: false,
      errorCode: 'marker_missing',
    })
    writeFileSync(path.join(root, '.mediavault-root'), '')
    expect(checkPath(root, { marker: '.mediavault-root' })).toMatchObject({
      ok: true,
      markerFound: true,
    })
  })

  test.skipIf(process.getuid?.() === 0)('rejects a directory without read permission', () => {
    const root = makeRoot()
    chmodSync(root, 0o000)
    try {
      expect(checkPath(root)).toMatchObject({ ok: false, errorCode: 'unreadable' })
    } finally {
      chmodSync(root, 0o700)
    }
  })

  test('warns when two roots share one device', () => {
    const root = makeRoot()
    const a = path.join(root, 'a')
    const b = path.join(root, 'b')
    mkdirSync(a)
    mkdirSync(b)
    const report = runPreflight({ paths: [a, b] })
    expect(report.ok).toBe(true)
    expect(report.warnings.some((warning) => warning.includes('share one device'))).toBe(true)
  })

  test('fails the report when one required path fails', () => {
    const root = makeRoot()
    const report = runPreflight({ paths: [root, path.join(root, 'missing')], requireAll: true })
    expect(report.ok).toBe(false)
    expect(report.paths.filter((result) => !result.ok)).toHaveLength(1)
  })
})

describe('preflight command', () => {
  const script = path.join(import.meta.dir, 'preflight.ts')

  test('exits 0 for a readable directory', () => {
    const root = makeRoot()
    const result = Bun.spawnSync({ cmd: [process.execPath, script, '--paths', root] })
    expect(result.exitCode).toBe(0)
  })

  test('exits 1 for a missing required directory', () => {
    const root = makeRoot()
    const result = Bun.spawnSync({
      cmd: [process.execPath, script, '--paths', path.join(root, 'missing')],
    })
    expect(result.exitCode).toBe(1)
  })

  test('prints JSON when asked', () => {
    const root = makeRoot()
    const result = Bun.spawnSync({ cmd: [process.execPath, script, '--paths', root, '--json'] })
    const report = JSON.parse(result.stdout.toString()) as { ok: boolean; paths: unknown[] }
    expect(report.ok).toBe(true)
    expect(report.paths).toHaveLength(1)
  })
})
