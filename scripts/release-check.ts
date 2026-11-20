/**
 * Every release gate in one command, and the only definition of that list.
 *
 *   bun run release:check
 */
import path from 'node:path'
import { APP_VERSION } from '@mediavault/shared'

const ROOT = path.resolve(import.meta.dir, '..')

const GATES: Array<{ name: string; command: string[] }> = [
  { name: 'typecheck', command: ['bun', 'run', 'typecheck'] },
  { name: 'tests', command: ['bun', 'test'] },
  { name: 'build', command: ['bun', 'run', '--cwd', 'apps/web', 'build'] },
  { name: 'smoke', command: ['bun', 'run', 'smoke'] },
]

const pkg = (await Bun.file(path.join(ROOT, 'package.json')).json()) as { version?: string }
if (pkg.version !== APP_VERSION) {
  console.error(`release check failed: package.json is ${pkg.version}, APP_VERSION is ${APP_VERSION}`)
  process.exit(1)
}
console.log(`ok   version ${APP_VERSION}`)

let totalMs = 0
for (const gate of GATES) {
  const startedAt = performance.now()
  const child = Bun.spawn(gate.command, { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' })
  const code = await child.exited
  const elapsedMs = performance.now() - startedAt
  totalMs += elapsedMs
  const elapsed = `${(elapsedMs / 1000).toFixed(1)}s`
  if (code !== 0) {
    console.error(`  FAIL ${gate.name.padEnd(15)}${elapsed}`)
    console.error(`release check failed at ${gate.name}`)
    process.exit(1)
  }
  console.log(`  ok   ${gate.name.padEnd(15)}${elapsed}`)
}

console.log(`release check passed: ${GATES.length} gates in ${(totalMs / 1000).toFixed(1)}s`)
