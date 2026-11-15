import path from 'node:path'

const root = path.resolve(import.meta.dir, '..')
const env = {
  ...process.env,
  DATA_DIR: process.env.DATA_DIR ?? path.join(root, 'data'),
  CACHE_DIR: process.env.CACHE_DIR ?? path.join(root, 'cache'),
  MEDIA_ROOT: process.env.MEDIA_ROOT ?? path.join(root, 'sample-media'),
  PORT: process.env.PORT ?? '8787',
}

const children = [
  Bun.spawn(['bun', 'run', 'apps/api/src/index.ts'], {
    cwd: root,
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  }),
  Bun.spawn(['bun', 'run', 'apps/worker/src/index.ts'], {
    cwd: root,
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  }),
  Bun.spawn(['bun', 'run', 'dev'], {
    cwd: path.join(root, 'apps/web'),
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  }),
]

console.log('MediaVault dev')
console.log(`  web  http://127.0.0.1:5173`)
console.log(`  api  http://127.0.0.1:${env.PORT}`)
console.log(`  media ${env.MEDIA_ROOT}`)

let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

const exitCode = await Promise.race(children.map((child) => child.exited))
if (!stopping) {
  console.error(`a dev process exited with ${exitCode}`)
  for (const child of children) child.kill()
  process.exit(exitCode === 0 ? 1 : exitCode)
}
