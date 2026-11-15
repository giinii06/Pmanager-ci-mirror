import type { Db } from '@mediavault/database'
import type { ApiConfig } from './config'
import { Semaphore } from './semaphore'

export interface AppContext {
  config: ApiConfig
  db: Db
  thumbnails: Semaphore
  previews: Semaphore
}
