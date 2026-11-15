import path from 'node:path'
import { openDatabase } from '@mediavault/database'
import { buildApp } from './app'
import { loadConfig } from './config'
import type { AppContext } from './context'
import { Semaphore } from './semaphore'

const config = await loadConfig()
const db = openDatabase(path.join(config.dataDir, 'mediavault.db'))

const ctx: AppContext = {
  config,
  db,
  thumbnails: new Semaphore(3),
  previews: new Semaphore(2),
}

const app = await buildApp(ctx)
await app.listen({ port: config.port, host: config.host })
app.log.info(
  { mediaRoot: config.mediaRoot, cacheDir: config.cacheDir, accel: config.accel },
  'MediaVault API ready',
)

async function shutdown(): Promise<void> {
  await app.close()
  db.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
