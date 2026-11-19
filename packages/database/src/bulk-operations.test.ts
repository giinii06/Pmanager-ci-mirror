import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  cancelMutationPreCommit,
  claimNextBulkItem,
  claimNextBulkOperation,
  claimNextMutation,
  countMissingAssets,
  createBulkOperation,
  createDeleteMutation,
  createLibrary,
  createMoveMutation,
  createUser,
  finishBulkItem,
  getBulkOperation,
  getBulkOperationCounts,
  getBulkOperationErrorGroups,
  getFileMutation,
  getMutationAsset,
  insertAsset,
  listBulkOperationItems,
  markAssetPendingDelete,
  markAssetPendingMutation,
  openDatabase,
  releaseBulkLease,
  releaseMutationLease,
  requestBulkCancel,
  retryBulkItems,
  softDeleteMissing,
  touchAssets,
  updateAssetLocation,
  upsertFolder,
  type Db,
} from './index'

let db: Db

beforeEach(() => {
  db = openDatabase(':memory:')
  createUser(db, { id: 'u1', username: 'owner', passwordHash: 'h', createdAt: 1 })
  createUser(db, { id: 'u2', username: 'guest', passwordHash: 'h', createdAt: 1 })
})

afterEach(() => {
  db.close()
})

function create(overrides: Partial<Parameters<typeof createBulkOperation>[1]> = {}) {
  return createBulkOperation(db, {
    id: 'op1',
    userId: 'u1',
    kind: 'tag_add',
    selectionKind: 'ids',
    selectionJson: JSON.stringify({ kind: 'ids', assetIds: ['a1', 'a2'] }),
    snapshotCount: 2,
    snapshotHash: 'hash-1',
    snapshotGeneration: 'gen-1',
    paramsJson: JSON.stringify({ tagId: 't1' }),
    requestKey: 'u1:req-1',
    items: [
      { assetId: 'a1', filename: 'one.mp4', relativePath: 'one.mp4', sizeBytes: 10 },
      { assetId: 'a2', filename: 'two.mp4', relativePath: 'two.mp4', sizeBytes: 20 },
    ],
    now: 100,
    ...overrides,
  })
}

describe('bulk operations', () => {
  test('create freezes the item list and a repeated request key returns the same operation', () => {
    const first = create()
    expect(first.created).toBe(true)
    expect(first.record.state).toBe('queued')
    expect(first.record.snapshotCount).toBe(2)

    const second = create({ id: 'op2' })
    expect(second.created).toBe(false)
    expect(second.record.id).toBe('op1')
    expect(listBulkOperationItems(db, 'op1').map((item) => item.assetId)).toEqual(['a1', 'a2'])
    expect(listBulkOperationItems(db, 'op1').map((item) => item.position)).toEqual([0, 1])
  })

  test('counts, error groups and item filters read the per-file outcomes', () => {
    create()
    const first = claimNextBulkItem(db, 'op1', 200)!
    finishBulkItem(db, first.id, 'succeeded', null, 201)
    const second = claimNextBulkItem(db, 'op1', 202)!
    finishBulkItem(db, second.id, 'held', { code: 'source_offline', message: 'offline' }, 203)

    expect(getBulkOperationCounts(db, 'op1')).toEqual({
      total: 2,
      pending: 0,
      running: 0,
      succeeded: 1,
      failed: 0,
      held: 1,
      cancelled: 0,
    })
    expect(getBulkOperationErrorGroups(db, 'op1')).toEqual([
      { code: 'source_offline', message: 'offline', count: 1 },
    ])
    expect(listBulkOperationItems(db, 'op1', { state: 'held' }).map((item) => item.assetId)).toEqual([
      'a2',
    ])
  })

  test('a claim fences the lease and only the holder can transition the parent', () => {
    create()
    const claimed = claimNextBulkOperation(db, 200, { workerId: 'w1', leaseMs: 1_000 })!
    expect(claimed.leaseOwner).toBe('w1')
    expect(claimed.leaseEpoch).toBe(1)

    expect(
      claimNextBulkOperation(db, 201, { workerId: 'w2', leaseMs: 1_000 }),
    ).toBeNull()

    const lost = db
      .query<null, [string, string, number]>(
        `UPDATE bulk_operations SET state = 'running' WHERE id = ? AND lease_owner = ? AND lease_epoch = ?`,
      )
      .run('op1', 'w1', 2)
    expect(lost.changes).toBe(0)

    const own = db
      .query<null, [string, string, number]>(
        `UPDATE bulk_operations SET state = 'running' WHERE id = ? AND lease_owner = ? AND lease_epoch = ?`,
      )
      .run('op1', 'w1', 1)
    expect(own.changes).toBe(1)
  })

  test('cancel stops pending items and leaves a running one for the worker', () => {
    create()
    const running = claimNextBulkItem(db, 'op1', 200)!
    expect(running.assetId).toBe('a1')

    expect(requestBulkCancel(db, 'op1', 'u1', 210)).toBe('cancelling')
    expect(getBulkOperation(db, 'op1')!.state).toBe('cancelling')
    const items = listBulkOperationItems(db, 'op1')
    expect(items.find((item) => item.assetId === 'a1')!.state).toBe('running')
    expect(items.find((item) => item.assetId === 'a2')!.state).toBe('cancelled')

    finishBulkItem(db, running.id, 'succeeded', null, 220)
    expect(requestBulkCancel(db, 'op1', 'u1', 230)).toBe('cancelled')
    expect(getBulkOperation(db, 'op1')!.state).toBe('cancelled')
    expect(getBulkOperationCounts(db, 'op1').succeeded).toBe(1)
  })

  test('cancel refuses another user and a finished operation', () => {
    create()
    expect(requestBulkCancel(db, 'op1', 'u2', 200)).toBe('missing')
    requestBulkCancel(db, 'op1', 'u1', 200)
    expect(requestBulkCancel(db, 'op1', 'u1', 201)).toBe('not_active')
  })

  test('retry resets failed and held items and queues the operation again', () => {
    create()
    for (const state of ['failed', 'held'] as const) {
      const item = claimNextBulkItem(db, 'op1', 200)!
      finishBulkItem(db, item.id, state, { code: 'item_failed', message: 'boom' }, 201)
    }
    const claimed = claimNextBulkOperation(db, 300, { workerId: 'w1', leaseMs: 1_000 })!
    expect(claimed.id).toBe('op1')

    // A live lease refuses the retry.
    expect(retryBulkItems(db, 'op1', 'u1', null, 310)).toBeNull()

    releaseBulkLease(db, 'op1', { workerId: 'w1', leaseEpoch: claimed.leaseEpoch, now: 320 })
    // The parent is still queued, so a retry is refused until it finishes.
    expect(retryBulkItems(db, 'op1', 'u1', null, 330)).toBeNull()

    db.query<null, []>(`UPDATE bulk_operations SET state = 'completed_with_errors'`).run()
    expect(retryBulkItems(db, 'op1', 'u1', null, 340)).toBe(2)
    expect(getBulkOperation(db, 'op1')!.state).toBe('queued')
    expect(getBulkOperationCounts(db, 'op1').pending).toBe(2)
  })

  test('retry with item ids touches only those items', () => {
    create()
    const first = claimNextBulkItem(db, 'op1', 200)!
    finishBulkItem(db, first.id, 'failed', { code: 'x', message: 'x' }, 201)
    const second = claimNextBulkItem(db, 'op1', 202)!
    finishBulkItem(db, second.id, 'failed', { code: 'y', message: 'y' }, 203)
    db.query<null, []>(`UPDATE bulk_operations SET state = 'completed_with_errors'`).run()

    expect(retryBulkItems(db, 'op1', 'u1', [second.id], 300)).toBe(1)
    const items = listBulkOperationItems(db, 'op1')
    expect(items.find((item) => item.id === first.id)!.state).toBe('failed')
    expect(items.find((item) => item.id === second.id)!.state).toBe('pending')
  })

  test('another user cannot read the operation', () => {
    create()
    expect(getBulkOperation(db, 'op1', 'u2')).toBeNull()
    expect(getBulkOperation(db, 'op1', 'u1')).not.toBeNull()
  })
})

describe('move support', () => {
  function seedAsset() {
    createLibrary(db, { id: 'lib1', name: 'Lib', rootPath: 'Lib', createdAt: 1 })
    const folder = upsertFolder(db, {
      id: 'f1',
      libraryId: 'lib1',
      parentId: null,
      relativePath: '',
      name: 'Lib',
      depth: 0,
      scanId: 's1',
      createdAt: 1,
    })
    insertAsset(db, {
      id: 'a1',
      libraryId: 'lib1',
      folderId: folder,
      relativePath: 'clip.mp4',
      filename: 'clip.mp4',
      kind: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 10,
      mtimeMs: 5,
      width: null,
      height: null,
      durationMs: null,
      takenAt: 1,
      videoCodec: null,
      audioCodec: null,
      container: null,
      indexedAt: 1,
      scanId: 's1',
    })
    return folder
  }

  test('a move updates the location without bumping the file version and clears the claim', () => {
    const folder = seedAsset()
    db.query<null, []>(`UPDATE assets SET pending_delete_mutation_id = 'm1' WHERE id = 'a1'`).run()

    expect(updateAssetLocation(db, 'a1', 'm1', 1, {
      libraryId: 'lib1',
      folderId: folder,
      relativePath: 'moved/clip.mp4',
      filename: 'clip.mp4',
    })).toBe(true)
    const row = db
      .query<{ relativePath: string; fileVersion: number; pending: string | null }, []>(
        `SELECT relative_path AS relativePath, file_version AS fileVersion,
                pending_delete_mutation_id AS pending FROM assets WHERE id = 'a1'`,
      )
      .get()!
    expect(row).toEqual({ relativePath: 'moved/clip.mp4', fileVersion: 1, pending: null })
  })

  test('a move refuses a changed file version or a lost claim', () => {
    const folder = seedAsset()
    db.query<null, []>(`UPDATE assets SET pending_delete_mutation_id = 'm1' WHERE id = 'a1'`).run()
    expect(updateAssetLocation(db, 'a1', 'm1', 2, {
      libraryId: 'lib1',
      folderId: folder,
      relativePath: 'x.mp4',
      filename: 'x.mp4',
    })).toBe(false)
    expect(updateAssetLocation(db, 'a1', 'other', 1, {
      libraryId: 'lib1',
      folderId: folder,
      relativePath: 'x.mp4',
      filename: 'x.mp4',
    })).toBe(false)
  })

  test('a move claim does not hide the asset from the library', () => {
    seedAsset()
    const mutation = createDeleteMutation(db, {
      assetId: 'a1',
      libraryId: 'lib1',
      userId: 'u1',
      requestKey: 'u1:move-1',
      requestedFileVersion: 1,
      sourceRel: 'clip.mp4',
      now: 100,
    }).record
    const claimed = claimNextMutation(db, 110, { workerId: 'w1', leaseMs: 60_000 })!
    const fence = { workerId: 'w1', leaseEpoch: claimed.leaseEpoch, now: 120 }

    expect(markAssetPendingMutation(db, 'a1', mutation.id, 1, fence)).toBe(true)
    const row = db
      .query<{ deletedAt: number | null; pending: string | null }, []>(
        `SELECT deleted_at AS deletedAt, pending_delete_mutation_id AS pending FROM assets WHERE id = 'a1'`,
      )
      .get()!
    expect(row.deletedAt).toBeNull()
    expect(row.pending).toBe(mutation.id)
    // The scanner cannot clear a row a move owns.
    expect(touchAssets(db, ['a1'], 'scan-2').size).toBe(0)
    // The file sits in quarantine before the commit, so a scan that misses the
    // old path must not treat the claim as a deletion.
    expect(countMissingAssets(db, 'lib1', 'scan-2')).toBe(0)
    expect(softDeleteMissing(db, 'lib1', 'scan-2', 999)).toBe(0)
    expect(getMutationAsset(db, 'a1')?.deletedAt).toBeNull()
  })

  test('a pre-commit cancel refuses a live lease and stops an idle mutation', () => {
    seedAsset()
    const live = createDeleteMutation(db, {
      assetId: 'a1',
      libraryId: 'lib1',
      userId: 'u1',
      requestKey: 'u1:c1',
      requestedFileVersion: 1,
      sourceRel: 'clip.mp4',
      now: 100,
    }).record
    const claimed = claimNextMutation(db, 110, { workerId: 'w1', leaseMs: 60_000 })!
    expect(cancelMutationPreCommit(db, live.id, 120)).toBe(false)
    releaseMutationLease(db, live.id, {
      workerId: 'w1',
      leaseEpoch: claimed.leaseEpoch,
      now: 130,
    })
    expect(cancelMutationPreCommit(db, live.id, 140)).toBe(true)
    expect(getFileMutation(db, live.id)!.state).toBe('cancelled_pre_commit')

    const done = createDeleteMutation(db, {
      assetId: 'a1',
      libraryId: 'lib1',
      userId: 'u1',
      requestKey: 'u1:c2',
      requestedFileVersion: 1,
      sourceRel: 'clip.mp4',
      now: 200,
    }).record
    db.query<null, [string]>(
      `UPDATE file_mutations SET state = 'quarantined' WHERE id = ?`,
    ).run(done.id)
    expect(cancelMutationPreCommit(db, done.id, 210)).toBe(false)
    expect(getFileMutation(db, done.id)!.state).toBe('quarantined')
  })

  test('a pre-commit cancel releases the claim validation took', () => {
    seedAsset()
    const del = createDeleteMutation(db, {
      assetId: 'a1',
      libraryId: 'lib1',
      userId: 'u1',
      requestKey: 'u1:c3',
      requestedFileVersion: 1,
      sourceRel: 'clip.mp4',
      now: 100,
    }).record
    const claimed = claimNextMutation(db, 110, { workerId: 'w1', leaseMs: 60_000 })!
    expect(
      markAssetPendingDelete(db, 'a1', del.id, 1, {
        workerId: 'w1',
        leaseEpoch: claimed.leaseEpoch,
        now: 120,
      }),
    ).toBe(true)
    db.query<null, [string]>(`UPDATE file_mutations SET state = 'validated' WHERE id = ?`).run(del.id)
    releaseMutationLease(db, del.id, { workerId: 'w1', leaseEpoch: claimed.leaseEpoch, now: 130 })

    expect(cancelMutationPreCommit(db, del.id, 140)).toBe(true)
    const hidden = db
      .query<{ deletedAt: number | null; pending: string | null }, []>(
        `SELECT deleted_at AS deletedAt, pending_delete_mutation_id AS pending FROM assets WHERE id = 'a1'`,
      )
      .get()!
    expect(hidden).toEqual({ deletedAt: null, pending: null })

    const move = createMoveMutation(db, {
      assetId: 'a1',
      libraryId: 'lib1',
      userId: 'u1',
      requestKey: 'u1:c4',
      requestedFileVersion: 1,
      sourceRel: 'clip.mp4',
      targetLibraryId: 'lib1',
      targetRel: 'other/clip.mp4',
      now: 200,
    }).record
    const moveClaim = claimNextMutation(db, 210, { workerId: 'w2', leaseMs: 60_000 })!
    expect(
      markAssetPendingMutation(db, 'a1', move.id, 1, {
        workerId: 'w2',
        leaseEpoch: moveClaim.leaseEpoch,
        now: 220,
      }),
    ).toBe(true)
    db.query<null, [string]>(`UPDATE file_mutations SET state = 'validated' WHERE id = ?`).run(move.id)
    releaseMutationLease(db, move.id, {
      workerId: 'w2',
      leaseEpoch: moveClaim.leaseEpoch,
      now: 230,
    })

    expect(cancelMutationPreCommit(db, move.id, 240)).toBe(true)
    const visible = db
      .query<{ deletedAt: number | null; pending: string | null }, []>(
        `SELECT deleted_at AS deletedAt, pending_delete_mutation_id AS pending FROM assets WHERE id = 'a1'`,
      )
      .get()!
    expect(visible).toEqual({ deletedAt: null, pending: null })
  })
})
