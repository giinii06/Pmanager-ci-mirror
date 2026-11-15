import { describe, expect, test } from 'bun:test'
import {
  createLibrary,
  insertAsset,
  listFolders,
  openDatabase,
  recomputeFolderCounts,
  softDeleteMissing,
  upsertFolder,
} from './index'
import type { NewAsset } from './assets'

const LIBRARY = 'lib1'

function asset(
  id: string,
  folderId: string,
  kind: 'image' | 'video',
  scanId = 's1',
): NewAsset {
  return {
    id,
    libraryId: LIBRARY,
    folderId,
    relativePath: `Photos/${id}.${kind === 'image' ? 'jpg' : 'mp4'}`,
    filename: `${id}.${kind === 'image' ? 'jpg' : 'mp4'}`,
    kind,
    mimeType: kind === 'image' ? 'image/jpeg' : 'video/mp4',
    sizeBytes: 1_000,
    mtimeMs: 1_000,
    width: 1_600,
    height: 1_067,
    durationMs: kind === 'video' ? 5_000 : null,
    takenAt: 10_000,
    videoCodec: kind === 'video' ? 'h264' : null,
    audioCodec: kind === 'video' ? 'aac' : null,
    container: kind === 'video' ? 'mp4' : null,
    indexedAt: 20_000,
    scanId,
  }
}

describe('folder counts', () => {
  test('directImageCount counts only this folder\'s live images', () => {
    const db = openDatabase(':memory:')
    createLibrary(db, { id: LIBRARY, name: 'Photos', rootPath: 'Photos', createdAt: 1 })

    const root = upsertFolder(db, {
      id: 'root',
      libraryId: LIBRARY,
      parentId: null,
      relativePath: 'Photos',
      name: 'Photos',
      depth: 0,
      scanId: 's1',
    })
    const child = upsertFolder(db, {
      id: 'child',
      libraryId: LIBRARY,
      parentId: root,
      relativePath: 'Photos/Busan',
      name: 'Busan',
      depth: 1,
      scanId: 's1',
    })
    const videoOnly = upsertFolder(db, {
      id: 'vonly',
      libraryId: LIBRARY,
      parentId: root,
      relativePath: 'Photos/Clips',
      name: 'Clips',
      depth: 1,
      scanId: 's1',
    })

    insertAsset(db, asset('img1', root, 'image'))
    insertAsset(db, asset('img2', root, 'image'))
    insertAsset(db, asset('video1', root, 'video'))
    insertAsset(db, asset('gone', root, 'image', 's0'))
    insertAsset(db, asset('img3', child, 'image'))
    insertAsset(db, asset('img4', child, 'image'))
    insertAsset(db, asset('video2', videoOnly, 'video'))

    softDeleteMissing(db, LIBRARY, 's1', 30_000)
    recomputeFolderCounts(db, LIBRARY)

    const byId = new Map(listFolders(db, LIBRARY).map((folder) => [folder.id, folder]))
    expect(byId.get(root)).toMatchObject({ directImageCount: 2, assetCount: 6 })
    expect(byId.get(child)).toMatchObject({ directImageCount: 2, assetCount: 2 })
    expect(byId.get(videoOnly)).toMatchObject({ directImageCount: 0, assetCount: 1 })
    db.close()
  })
})
