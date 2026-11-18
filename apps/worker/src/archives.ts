import path from 'node:path'
import {
  enqueueArchiveJobIfNeeded,
  enqueueJob,
  type Db,
} from '@mediavault/database'
import { discoverArchiveSetsInDir } from '@mediavault/media'
import { newId, type Priority } from '@mediavault/shared'

/**
 * Discovers ready archive sets in `dir` and enqueues deduplicated `process_archive`
 * worker jobs so both library scans and filesystem watchers share one code path.
 */
export async function enqueueArchivesInDir(
  db: Db,
  libraryId: string,
  libRoot: string,
  dir: string,
  priority: Priority,
  now = Date.now(),
): Promise<number> {
  const sets = await discoverArchiveSetsInDir(dir)
  let queued = 0
  for (const set of sets) {
    const relPath = path.relative(libRoot, set.primaryPath).replace(/\\/g, '/')
    if (!relPath || relPath.startsWith('..')) continue
    const { created, record } = enqueueArchiveJobIfNeeded(
      db,
      {
        id: newId(),
        libraryId,
        archivePath: relPath,
        signature: set.signature,
      },
      now,
    )
    if (!created) continue
    enqueueJob(
      db,
      {
        dedupeKey: `archive:${record.id}`,
        kind: 'process_archive',
        priority,
        libraryId,
        payload: {
          archiveJobId: record.id,
          libraryId,
          primaryPath: set.primaryPath,
          volumes: set.volumes,
        },
      },
      now,
    )
    queued += 1
  }
  return queued
}
