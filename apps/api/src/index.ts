import path from 'node:path'
import { openDatabase } from '@mediavault/database'
import { buildApp } from './app'
import { loadConfig } from './config'
import type { AppContext } from './context'
import { ensureIndexJobs } from './index-trigger'
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

// The scanner writes the assets table directly, so the API cannot hear about a
// new file. This pass finds videos without a scene or face job and queues them;
// it is idempotent, so a repeat only costs one query per video.
const INDEX_INTERVAL_MS = 5 * 60_000
function indexPass(): void {
  try {
    const result = ensureIndexJobs(ctx, Date.now())
    if (result.scenes > 0 || result.faces > 0) {
      app.log.info(result, 'queued scene and face jobs')
    }
  } catch (error) {
    app.log.error({ err: error }, 'the index pass failed')
  }
}
indexPass()
setInterval(indexPass, INDEX_INTERVAL_MS).unref()

async function shutdown(): Promise<void> {
  await app.close()
  db.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
