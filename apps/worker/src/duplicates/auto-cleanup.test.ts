import { describe, expect, test } from 'bun:test'
import {
  createLibrary,
  getMutationByRequestKey,
  hasExactDuplicateKeeper,
  insertAsset,
  openDatabase,
  upsertFileFingerprint,
  upsertFolder,
  type Db,
} from '@mediavault/database'
import { queueExactDuplicateCleanup } from './auto-cleanup'

function setup() {
  const db = openDatabase(':memory:')
  createLibrary(db, { id: 'lib1', name: 'Test', rootPath: 'Test', createdAt: 1 })
  upsertFolder(db, {
    id: 'folder1', libraryId: 'lib1', parentId: null,
    relativePath: 'Test', name: 'Test', depth: 0, scanId: 'seed',
  })
  return db
}

function add(db: Db, id: string, digest: string): void {
  insertAsset(db, {
    id, libraryId: 'lib1', folderId: 'folder1',
    relativePath: id + '.mp4', filename: id + '.mp4',
    kind: 'video', mimeType: 'video/mp4', sizeBytes: 2048,
    mtimeMs: 1, width: null, height: null, durationMs: null,
    takenAt: 1, videoCodec: null, audioCodec: null,
    container: 'mp4', indexedAt: 1, scanId: 'seed',
  })
  upsertFileFingerprint(db, {
    assetId: id, fileVersion: 1, sizeBytes: 2048,
    quickHash: digest, fullHash: digest,
    deviceId: 1, inode: id === 'a' ? 1 : id === 'b' ? 2 : 3,
  }, 1)
}

describe('automatic exact duplicate cleanup', () => {
  test('queues deletion for every extra copy while preserving one deterministic keeper', () => {
    const db = setup()
    try {
      add(db, 'a', 'same')
      add(db, 'b', 'same')
      add(db, 'c', 'same')
      expect(queueExactDuplicateCleanup(db, 42)).toMatchObject({ groups: 1, queued: 2 })
      const rows = db.query<{ assetId: string }, []>(
        "SELECT asset_id AS assetId FROM file_mutations WHERE kind = 'delete' ORDER BY asset_id",
      ).all()
      expect(rows.map((row) => row.assetId)).toEqual(['b', 'c'])
      expect(getMutationByRequestKey(db, 'auto-duplicate:b:1:a:1')?.state).toBe('requested')
      expect(hasExactDuplicateKeeper(db, 'b', 1, 'a', 1)).toBe(true)
      expect(queueExactDuplicateCleanup(db, 43)).toMatchObject({ queued: 0 })
    } finally { db.close() }
  })

  test('different content is not queued and invalid keepers fail closed', () => {
    const db = setup()
    try {
      add(db, 'a', 'one')
      add(db, 'b', 'two')
      expect(queueExactDuplicateCleanup(db).queued).toBe(0)
      expect(hasExactDuplicateKeeper(db, 'b', 1, 'a', 1)).toBe(false)
      expect(hasExactDuplicateKeeper(db, 'b', 2, 'a', 1)).toBe(false)
      expect(hasExactDuplicateKeeper(db, 'b', 1, 'b', 1)).toBe(false)
    } finally { db.close() }
  })

  test('no extra deletion can be planned if a keeper is already scheduled for mutation', () => {
    const db = setup()
    try {
      add(db, 'a', 'same')
      add(db, 'b', 'same')
      db.query("UPDATE assets SET pending_delete_mutation_id = 'someone-else' WHERE id = 'a'").run()
      expect(hasExactDuplicateKeeper(db, 'b', 1, 'a', 1)).toBe(false)
      expect(queueExactDuplicateCleanup(db).queued).toBe(0)
    } finally { db.close() }
  })
})
