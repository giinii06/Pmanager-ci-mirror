import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createLibrary,
  duplicateGroupId,
  getDuplicateGroup,
  insertAsset,
  listDuplicateGroups,
  openDatabase,
  replaceDuplicateGroups,
  setDuplicateGroupState,
  upsertFileFingerprint,
  upsertFolder,
  type Db,
  type NewAsset,
} from './index'
import { MIGRATIONS, SCHEMA_VERSION } from './schema'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function seed(db: Db): void {
  createLibrary(db, { id: 'lib1', name: 'Lib', rootPath: 'Lib', createdAt: 1 })
  const folderId = upsertFolder(db, {
    id: 'f1',
    libraryId: 'lib1',
    parentId: null,
    relativePath: 'Lib',
    name: 'Lib',
    depth: 0,
    scanId: 'seed',
  })
  for (const [index, name] of ['a.mp4', 'b.mp4', 'c.mp4'].entries()) {
    const asset: NewAsset = {
      id: `a${index + 1}`,
      libraryId: 'lib1',
      folderId,
      relativePath: name,
      filename: name,
      kind: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 100,
      mtimeMs: 1_000,
      width: null,
      height: null,
      durationMs: null,
      takenAt: 1,
      videoCodec: null,
      audioCodec: null,
      container: 'mp4',
      indexedAt: 1,
      scanId: 'seed',
    }
    insertAsset(db, asset)
  }
}

describe('schema v22 duplicates', () => {
  test('a v21 database gains the duplicate tables and keeps its assets', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mv-v22-'))
    dirs.push(dir)
    const file = path.join(dir, 'legacy.db')

    const legacy = new Database(file)
    for (let index = 0; index < 21; index += 1) {
      MIGRATIONS[index]!((sql) => legacy.exec(sql))
    }
    legacy.exec('PRAGMA user_version = 21')
    legacy.exec("INSERT INTO libraries (id, name, root_path, created_at) VALUES ('lib1', 'Lib', 'Lib', 1)")
    legacy.exec(`INSERT INTO assets (
      id, library_id, folder_id, relative_path, filename, kind, mime_type, size_bytes,
      mtime_ms, width, height, duration_ms, taken_at, file_version, indexed_at
    ) VALUES ('a1', 'lib1', NULL, 'a.mp4', 'a.mp4', 'video', 'video/mp4', 100, 1000, NULL, NULL, NULL, 1, 1, 1)`)
    legacy.close()

    const db = openDatabase(file)

    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(
      SCHEMA_VERSION,
    )
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(22)
    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'file_fingerprints','duplicate_groups','duplicate_group_members'
         )
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name)
    expect(tables).toEqual(['duplicate_group_members', 'duplicate_groups', 'file_fingerprints'])
    const indexes = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name IN (
           'idx_file_fingerprints_full','ux_duplicate_groups_fingerprint',
           'idx_duplicate_group_members_asset'
         )
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name)
    expect(indexes).toEqual([
      'idx_duplicate_group_members_asset',
      'idx_file_fingerprints_full',
      'ux_duplicate_groups_fingerprint',
    ])
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM assets').get()!.n).toBe(1)
    db.close()
  })

  test('a group keeps its id and its decision across rebuilds, and a stale group is removed', () => {
    const db = openDatabase(':memory:')
    seed(db)

    const fingerprint = 'sha256:100:' + 'a'.repeat(64)
    const members = [
      { assetId: 'a1', confidence: 1, sameInode: false },
      { assetId: 'a2', confidence: 1, sameInode: true },
    ]

    const first = replaceDuplicateGroups(db, 'exact', [{ fingerprint, members }], 100)
    expect(first).toEqual({ created: 1, updated: 0, removed: 0 })

    const id = duplicateGroupId('exact', fingerprint)
    expect(id).toMatch(/^dup_[0-9a-f]{16}$/)
    expect(duplicateGroupId('exact', fingerprint)).toBe(id)

    const kept = setDuplicateGroupState(db, id, 'kept', 150)
    expect(kept?.state).toBe('kept')

    const again = replaceDuplicateGroups(db, 'exact', [{ fingerprint, members }], 200)
    expect(again).toEqual({ created: 0, updated: 1, removed: 0 })
    const preserved = getDuplicateGroup(db, id)!
    expect(preserved.state).toBe('kept')
    expect(preserved.createdAt).toBe(100)
    expect(preserved.updatedAt).toBe(200)
    expect(preserved.members.map((member) => member.assetId)).toEqual(['a1', 'a2'])
    expect(preserved.members[1]!.sameInode).toBe(true)
    expect(preserved.memberCount).toBe(2)
    expect(preserved.totalBytes).toBe(200)

    const replaced = replaceDuplicateGroups(
      db,
      'exact',
      [
        {
          fingerprint: 'sha256:100:' + 'b'.repeat(64),
          members: [
            { assetId: 'a1', confidence: 1, sameInode: false },
            { assetId: 'a3', confidence: 1, sameInode: false },
          ],
        },
      ],
      300,
    )
    expect(replaced).toEqual({ created: 1, updated: 0, removed: 1 })
    expect(getDuplicateGroup(db, id)).toBeNull()

    const cleared = replaceDuplicateGroups(db, 'exact', [], 400)
    expect(cleared).toEqual({ created: 0, updated: 0, removed: 1 })
    expect(listDuplicateGroups(db, { kind: 'exact', state: 'all', limit: 10 }).groups).toEqual([])
    db.close()
  })

  test('a group of one live member is not served, and a fingerprint follows its version', () => {
    const db = openDatabase(':memory:')
    seed(db)

    const fingerprint = 'sha256:100:' + 'c'.repeat(64)
    replaceDuplicateGroups(
      db,
      'exact',
      [
        {
          fingerprint,
          members: [
            { assetId: 'a1', confidence: 1, sameInode: false },
            { assetId: 'a2', confidence: 1, sameInode: false },
          ],
        },
      ],
      100,
    )
    const id = duplicateGroupId('exact', fingerprint)
    expect(getDuplicateGroup(db, id)?.memberCount).toBe(2)

    db.query<null, []>("UPDATE assets SET deleted_at = 500 WHERE id = 'a2'").run()
    expect(getDuplicateGroup(db, id)).toBeNull()
    expect(listDuplicateGroups(db, { kind: 'exact', state: 'all', limit: 10 }).groups).toEqual([])

    upsertFileFingerprint(
      db,
      {
        assetId: 'a1',
        fileVersion: 1,
        sizeBytes: 100,
        quickHash: 'q1',
        fullHash: 'f1',
        deviceId: 1,
        inode: 2,
      },
      100,
    )
    upsertFileFingerprint(
      db,
      {
        assetId: 'a1',
        fileVersion: 2,
        sizeBytes: 100,
        quickHash: 'q2',
        fullHash: 'f2',
        deviceId: 1,
        inode: 2,
      },
      200,
    )
    const rows = db
      .query<{ fileVersion: number; fullHash: string | null }, []>(
        "SELECT file_version AS fileVersion, full_hash AS fullHash FROM file_fingerprints WHERE asset_id = 'a1' ORDER BY file_version",
      )
      .all()
    expect(rows).toEqual([
      { fileVersion: 1, fullHash: 'f1' },
      { fileVersion: 2, fullHash: 'f2' },
    ])
    db.close()
  })
})
