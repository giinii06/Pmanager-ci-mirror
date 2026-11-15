import path from 'node:path'
import { openDatabase } from '@mediavault/database'
import { loadWorkerConfig } from './config'
import { runWorker } from './loop'

const config = await loadWorkerConfig()
const db = openDatabase(path.join(config.dataDir, 'mediavault.db'))
console.log(
  `[worker] watching ${config.dataDir} (media ${config.mediaRoot}, hwaccel ${config.hwaccel ?? 'cpu'})`,
)
await runWorker(db, config)
db.close()
