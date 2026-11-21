import {
  createDeleteMutation,
  exactDuplicateGroups,
  getMutationAsset,
  type Db,
} from '@mediavault/database'

/**
 * Queue only exact SHA-256 duplicates. One deterministic, live asset stays
 * untouched in every group; the existing mutation worker performs validation,
 * quarantine, DB commit and purge asynchronously.
 */
export function queueExactDuplicateCleanup(db: Db, now = Date.now()): {
  groups: number
  queued: number
  skipped: number
} {
  let queued = 0
  let skipped = 0
  const groups = exactDuplicateGroups(db)
  for (const group of groups) {
    const live = group.members
      .map((member) => getMutationAsset(db, member.assetId))
      .filter((asset) => asset && asset.deletedAt === null && asset.pendingDeleteMutationId === null)
      .sort((a, b) => a!.id.localeCompare(b!.id))
    // An in-progress operation cannot act as the sole retained copy.
    if (live.length < 2) {
      skipped += group.members.length
      continue
    }
    const keeper = live[0]!
    for (const target of live.slice(1)) {
      if (!target || target.id === keeper.id) continue
      // The delete engine re-checks that the protected keeper is still present
      // and has the same full hash immediately before it touches the target.
      const result = createDeleteMutation(db, {
        assetId: target.id,
        libraryId: target.libraryId,
        userId: null,
        requestKey: `auto-duplicate:${target.id}:${target.fileVersion}:${keeper.id}:${keeper.fileVersion}`,
        requestedFileVersion: target.fileVersion,
        sourceRel: target.relativePath,
        now,
      })
      if (result.created) queued += 1
      else skipped += 1
    }
  }
  return { groups: groups.length, queued, skipped }
}
