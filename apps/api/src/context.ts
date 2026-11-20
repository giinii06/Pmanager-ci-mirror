import type { Db } from '@mediavault/database'
import type { ApiConfig } from './config'
import type { RequestMetrics } from './observability'
import { Semaphore } from './semaphore'

export interface AppContext {
  config: ApiConfig
  db: Db
  /** The production entrypoint always sets this; tests that do not care may omit it. */
  metrics?: RequestMetrics
  thumbnails: Semaphore
  previews: Semaphore
}
