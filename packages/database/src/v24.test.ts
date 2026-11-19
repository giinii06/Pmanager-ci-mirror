import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createBulkOperation,
  createLibrary,
  createMoveMutation,
  createUser,
  getBulkOperation,
  getBulkOperationCounts,
  insertAsset,
  listBulkOperationItems,
  openDatabase,
  upsertFolder,
} from './index'
import { MIGRATIONS, SCHEMA_VERSION } from './schema'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function seed(legacy: Database): void {
  createUser(legacy, { id: 'u1', username: 'owner', passwordHash: 'h', createdAt: 1 })
  createLibrary(legacy, { id: 'lib1', name: 'Media', rootPath: 'Media', createdAt: 1 })
  const folderId = upsertFolder(legacy, {
    id: 'folder1',
    libraryId: 'lib1',
    parentId: null,
    relativePath: '',
    name: 'Media',
    depth: 0,
    scanId: 'seed',
  })
  insertAsset(legacy, {
    id: 'asset1',
    libraryId: 'lib1',
    folderId,
    relativePath: 'clip.mp4',
    filename: 'clip.mp4',
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 10,
    mtimeMs: 1,
    width: null,
    height: null,
    durationMs: null,
    takenAt: 1,
    videoCodec: null,
    audioCodec: null,
    container: 'mp4',
    indexedAt: 1,
    scanId: 'seed',
  })
}

describe('schema v24 bulk operations', () => {
  test('migrates a v23 database, keeps the asset, and enables a frozen bulk operation', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mv-v24-'))
    dirs.push(dir)
    const file = path.join(dir, 'legacy.db')

    const legacy = new Database(file)
    legacy.exec('PRAGMA foreign_keys = ON')
    for (let index = 0; index < 23; index += 1) {
      MIGRATIONS[index]!((sql) => legacy.exec(sql))
    }
    legacy.exec('PRAGMA user_version = 23')
    seed(legacy)
    legacy.close()

    const db = openDatabase(file)
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(
      SCHEMA_VERSION,
    )

    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('bulk_operations','bulk_operation_items')
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name)
    expect(tables).toEqual(['bulk_operation_items', 'bulk_operations'])

    const indexes = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (
           'ux_bulk_operation_items_slot','idx_bulk_operation_items_state',
           'idx_bulk_operation_items_mutation','idx_bulk_operations_state','idx_bulk_operations_user'
         ) ORDER BY name`,
      )
      .all()
      .map((row) => row.name)
    expect(indexes).toEqual([
      'idx_bulk_operation_items_mutation',
      'idx_bulk_operation_items_state',
      'idx_bulk_operations_state',
      'idx_bulk_operations_user',
      'ux_bulk_operation_items_slot',
    ])

    const mutationColumns = db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('file_mutations')")
      .all()
      .map((row) => row.name)
    expect(mutationColumns).toContain('target_library_id')
    expect(mutationColumns).toContain('target_rel')

    expect(
      db
        .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM assets WHERE deleted_at IS NULL')
        .get()?.n,
    ).toBe(1)
    expect(
      db
        .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM assets WHERE relative_path = ?')
        .get('clip.mp4')?.n,
    ).toBe(1)

    const created = createBulkOperation(db, {
      id: 'op1',
      userId: 'u1',
      kind: 'move',
      selectionKind: 'ids',
      selectionJson: JSON.stringify({ kind: 'ids', assetIds: ['asset1'] }),
      snapshotCount: 1,
      snapshotHash: 'hash',
      snapshotGeneration: 'gen',
      paramsJson: JSON.stringify({ targetLibraryId: 'lib1', targetFolder: 'sorted' }),
      requestKey: 'u1:req-1',
      items: [{ assetId: 'asset1', filename: 'clip.mp4', relativePath: 'clip.mp4', sizeBytes: 10 }],
      now: 100,
    })
    expect(created.created).toBe(true)
    expect(getBulkOperation(db, 'op1')?.state).toBe('queued')
    expect(getBulkOperationCounts(db, 'op1')).toEqual({
      total: 1,
      pending: 1,
      running: 0,
      succeeded: 0,
      failed: 0,
      held: 0,
      cancelled: 0,
    })
    expect(listBulkOperationItems(db, 'op1').map((item) => item.assetId)).toEqual(['asset1'])

    const move = createMoveMutation(db, {
      assetId: 'asset1',
      libraryId: 'lib1',
      userId: 'u1',
      requestKey: 'u1:move-1',
      requestedFileVersion: 1,
      sourceRel: 'clip.mp4',
      targetLibraryId: 'lib1',
      targetRel: 'sorted/clip.mp4',
      now: 200,
    })
    expect(move.record.targetLibraryId).toBe('lib1')
    expect(move.record.targetRel).toBe('sorted/clip.mp4')

    expect(db.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check).toBe(
      'ok',
    )
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
    db.close()
  })
})
