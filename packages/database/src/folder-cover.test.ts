import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  commitPermanentDelete,
  createLibrary,
  getFolder,
  insertAsset,
  listFolders,
  openDatabase,
  recomputeFolderCounts,
  setFolderCover,
  upsertFolder,
} from './index'
import { MIGRATIONS, SCHEMA_VERSION } from './schema'

const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function addImage(db: ReturnType<typeof openDatabase>, id: string, folderId: string, name: string, width: number, height: number, takenAt = 1_000) {
  insertAsset(db, {
    id,
    libraryId: 'lib1',
    folderId,
    relativePath: `${folderId}/${name}`,
    filename: name,
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 500,
    mtimeMs: 1_000,
    width,
    height,
    durationMs: null,
    takenAt,
    videoCodec: null,
    audioCodec: null,
    container: 'jpg',
    indexedAt: 1_000,
    scanId: 's1',
  })
}

describe('Schema v15 pinned folder cover thumbnail', () => {
  test('migrates a v14 database to the current schema cleanly', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mv-v15-'))
    tempDirs.push(dir)
    const file = path.join(dir, 'legacy.db')

    const legacy = new Database(file)
    legacy.exec('PRAGMA foreign_keys = ON')
    for (let i = 0; i < 14; i += 1) {
      MIGRATIONS[i]!((sql) => legacy.exec(sql))
    }
    legacy.exec('PRAGMA user_version = 14')
    createLibrary(legacy, { id: 'lib1', name: 'Media', rootPath: 'Media', createdAt: 1 })
    upsertFolder(legacy, {
      id: 'f1',
      libraryId: 'lib1',
      parentId: null,
      relativePath: 'Set1',
      name: 'Set1',
      depth: 1,
      scanId: 's1',
    })
    legacy.close()

    const db = openDatabase(file)
    const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()
    expect(version?.user_version).toBe(SCHEMA_VERSION)
    expect(getFolder(db, 'f1')?.coverAssetId).toBeNull()
    db.close()
  })

  test('pins cover across recomputeFolderCounts, propagates to empty parent, and clears on delete', () => {
    const db = openDatabase(':memory:')
    createLibrary(db, { id: 'lib1', name: 'Media', rootPath: 'Media', createdAt: 1 })
    upsertFolder(db, {
      id: 'parent',
      libraryId: 'lib1',
      parentId: null,
      relativePath: 'Root',
      name: 'Root',
      depth: 0,
      scanId: 's1',
    })
    upsertFolder(db, {
      id: 'f1',
      libraryId: 'lib1',
      parentId: 'parent',
      relativePath: 'Root/Set1',
      name: 'Set1',
      depth: 1,
      scanId: 's1',
    })
    upsertFolder(db, {
      id: 'f2',
      libraryId: 'lib1',
      parentId: 'parent',
      relativePath: 'Root/Set2',
      name: 'Set2',
      depth: 1,
      scanId: 's1',
    })

    addImage(db, 'img1', 'f1', '01.jpg', 100, 200, 1_000)
    addImage(db, 'img2', 'f1', '02.jpg', 300, 400, 2_000)
    addImage(db, 'img3', 'f1', '03.jpg', 500, 600, 3_000)
    addImage(db, 'other', 'f2', 'a.jpg', 200, 200, 500)
    insertAsset(db, {
      id: 'vid1',
      libraryId: 'lib1',
      folderId: 'f1',
      relativePath: 'Root/Set1/clip.mp4',
      filename: 'clip.mp4',
      kind: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 1_000,
      mtimeMs: 1_000,
      width: 1920,
      height: 1080,
      durationMs: 5_000,
      takenAt: 4_000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      container: 'mp4',
      indexedAt: 1_000,
      scanId: 's1',
    })

    recomputeFolderCounts(db, 'lib1')
    expect(getFolder(db, 'f1')?.coverAssetId).toBe('img2')

    const res = setFolderCover(db, 'f1', 'img1')
    expect(res.status).toBe('ok')
    if (res.status === 'ok') {
      expect(res.folder.coverAssetId).toBe('img1')
      expect(res.folder.coverWidth).toBe(100)
      expect(res.folder.coverHeight).toBe(200)
    }
    expect(getFolder(db, 'parent')?.coverAssetId).toBe('img1')

    recomputeFolderCounts(db, 'lib1')
    expect(getFolder(db, 'f1')?.coverAssetId).toBe('img1')
    expect(listFolders(db, 'lib1').find((f) => f.id === 'f1')?.coverAssetId).toBe('img1')

    expect(setFolderCover(db, 'missing-folder', 'img1').status).toBe('folder_not_found')
    expect(setFolderCover(db, 'f1', 'other').status).toBe('invalid_asset')
    expect(setFolderCover(db, 'f1', 'vid1').status).toBe('invalid_asset')

    commitPermanentDelete(db, 'img1', 'lib1')
    const afterDelete = getFolder(db, 'f1')
    expect(afterDelete?.coverAssetId).toBe('img3')
    const pinnedCol = db
      .query<{ pinned: string | null }, [string]>('SELECT pinned_cover_asset_id AS pinned FROM folders WHERE id = ?')
      .get('f1')
    expect(pinnedCol?.pinned).toBeNull()
    db.close()
  })
})
