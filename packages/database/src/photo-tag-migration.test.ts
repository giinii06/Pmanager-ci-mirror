import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createLibrary, createTag, insertAsset, listAssets, listTags,
  openDatabase, upsertFolder,
} from './index'
import { MIGRATIONS, SCHEMA_VERSION } from './schema'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('photo tag migration', () => {
  test('v27 image attachments migrate without removing video assignments', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mv-photo-tags-'))
    tempDirs.push(dir)
    const filename = path.join(dir, 'legacy.db')
    const legacy = new Database(filename)
    legacy.exec('PRAGMA foreign_keys = ON')
    for (let index = 0; index < 27; index += 1) MIGRATIONS[index]!((sql) => legacy.exec(sql))
    legacy.exec('PRAGMA user_version = 27')
    createLibrary(legacy, { id: 'lib', name: 'Media', rootPath: 'Media', createdAt: 1 })
    const folderId = upsertFolder(legacy, {
      id: 'folder', libraryId: 'lib', parentId: null,
      relativePath: '', name: 'Media', depth: 0, scanId: 'scan',
    })
    for (const kind of ['image', 'video'] as const) {
      insertAsset(legacy, {
        id: kind, libraryId: 'lib', folderId, relativePath: kind + '.jpg',
        filename: kind + '.jpg', kind, mimeType: 'image/jpeg', sizeBytes: 50, mtimeMs: 1,
        width: 80, height: 60, durationMs: null, takenAt: 1, videoCodec: null,
        audioCodec: null, container: null, indexedAt: 1, scanId: 'scan',
      })
    }
    createTag(legacy, 'old', 'Family', 1)
    legacy.query("INSERT INTO asset_tags (asset_id, tag_id, created_at) VALUES ('image', 'old', 1), ('video', 'old', 1)").run()
    legacy.close()

    const db = openDatabase(filename)
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION)
    expect(listAssets(db, { kind: 'image' }, null, 10).records[0]?.tags.map((tag) => tag.name)).toEqual(['Family'])
    expect(listAssets(db, { kind: 'video' }, null, 10).records[0]?.tags.map((tag) => tag.name)).toEqual(['Family'])
    expect(listTags(db, 'image').map((tag) => tag.name)).toEqual(['Family'])
    expect(listTags(db, 'video').map((tag) => tag.name)).toEqual(['Family'])
    expect(db.query<{ n: number }, []>(
      "SELECT count(*) AS n FROM asset_tags WHERE asset_id = 'image'",
    ).get()?.n).toBe(0)
    db.close()
  })
})
