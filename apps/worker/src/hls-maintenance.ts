import { rm } from 'node:fs/promises'
import {
  failOrphanedHlsGenerations,
  listHlsDeleting,
  listHlsGcCandidates,
  markHlsGenerationDeleting,
  markHlsGenerationRemoved,
  type Db,
} from '@mediavault/database'
import { resolveInside } from '@mediavault/media'

/** A generation must be idle this long before GC may consider it. */
export const HLS_GC_IDLE_MS = 60 * 60_000

export interface HlsGcSummary {
  removed: number
  orphaned: number
}

async function removeGenerationDir(cacheDir: string, storageRel: string | null): Promise<boolean> {
  if (!storageRel) return true
  const target = resolveInside(cacheDir, storageRel)
  if (!target) return false
  await rm(target, { recursive: true, force: true })
  return true
}

/**
 * Removes only generations already marked `deleting` and never touches the
 * active one. A crash between the marker and the unlink is repaired on the next
 * pass because `deleting` rows are retried before new victims are chosen.
 */
export async function collectHlsGarbage(
  db: Db,
  cacheDir: string,
  now = Date.now(),
): Promise<HlsGcSummary> {
  const orphaned = failOrphanedHlsGenerations(db)
  let removed = 0

  for (const generation of listHlsDeleting(db, 10)) {
    if (!(await removeGenerationDir(cacheDir, generation.storageRel))) continue
    if (markHlsGenerationRemoved(db, generation.id)) removed += 1
  }

  for (const generation of listHlsGcCandidates(db, now, HLS_GC_IDLE_MS, 5)) {
    if (!markHlsGenerationDeleting(db, generation.id)) continue
    if (!(await removeGenerationDir(cacheDir, generation.storageRel))) continue
    if (markHlsGenerationRemoved(db, generation.id)) removed += 1
  }

  return { removed, orphaned }
}
