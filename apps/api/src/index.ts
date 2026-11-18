import path from 'node:path'
import { openDatabase } from '@mediavault/database'
import { buildApp } from './app'
import { loadConfig } from './config'
import type { AppContext } from './context'
import { ensurePipelineJobs } from './index-trigger'
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
// new file. This pass finds work that is missing for the library and queues it;
// it is idempotent, so a repeat only costs one query per video.
const INDEX_INTERVAL_MS = 5 * 60_000
function indexPass(): void {
  try {
    const result = ensurePipelineJobs(ctx, Date.now())
    const queued =
      result.scanned +
      result.asr +
      result.translations +
      result.embeddings +
      result.scenes
    if (queued > 0) app.log.info(result, 'queued pipeline jobs')
  } catch (error) {
    app.log.error({ err: error }, 'the pipeline pass failed')
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
