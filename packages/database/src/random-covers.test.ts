import { describe, expect, test } from 'bun:test'
import {
  addTagToAsset,
  createLibrary,
  createTag,
  insertAsset,
  listAllFolders,
  listTags,
  openDatabase,
  randomizeFolderCovers,
  upsertFolder,
} from './index'

function addAsset(
  db: ReturnType<typeof openDatabase>,
  id: string,
  folderId: string,
  kind: 'image' | 'video',
) {
  insertAsset(db, {
    id, libraryId: 'lib', folderId, relativePath: id + '.jpg',
    filename: id + '.jpg', kind, mimeType: kind === 'image' ? 'image/jpeg' : 'video/mp4',
    sizeBytes: 100, mtimeMs: 100, width: 300, height: 200,
    durationMs: kind === 'video' ? 1000 : null,
    takenAt: 100, videoCodec: null, audioCodec: null, container: null,
    indexedAt: 1, scanId: 'scan',
  })
}

describe('random album and tag cover responses', () => {
  test('folder display chooses only its own live photos and never persists a pin', () => {
    const db = openDatabase(':memory:')
    createLibrary(db, { id:'lib', name:'Library', rootPath:'Media', createdAt:1 })
    for (const id of ['f1','f2']) upsertFolder(db, {
      id, libraryId:'lib', parentId:null, relativePath:id, name:id, depth:1, scanId:'scan',
    })
    addAsset(db,'a1','f1','image')
    addAsset(db,'a2','f1','image')
    addAsset(db,'other','f2','image')
    addAsset(db,'video','f1','video')
    db.query('UPDATE assets SET deleted_at = 10 WHERE id = ?').run('a2')
    const folders = listAllFolders(db)
    const original = folders.find((f)=>f.id === 'f1')!
    const displayed = randomizeFolderCovers(db, folders)
    expect(displayed.find((f)=>f.id === 'f1')?.coverAssetId).toBe('a1')
    expect(displayed.find((f)=>f.id === 'f2')?.coverAssetId).toBe('other')
    expect(displayed.find((f)=>f.id === 'f1')?.coverWidth).toBe(300)
    expect(folders.find((f)=>f.id === 'f1')).toEqual(original)
    const pin = db.query<{ value: string | null }, [string]>(
      'SELECT pinned_cover_asset_id AS value FROM folders WHERE id = ?',
    ).get('f1')
    expect(pin?.value).toBeNull()
    db.close()
  })

  test('tags count views and votes per kind and pick only eligible cover assets', () => {
    const db = openDatabase(':memory:')
    createLibrary(db, { id:'lib', name:'Library', rootPath:'Media', createdAt:1 })
    upsertFolder(db, {id:'f1',libraryId:'lib',parentId:null,relativePath:'f1',name:'f1',depth:1,scanId:'scan'})
    addAsset(db,'photo1','f1','image')
    addAsset(db,'photo2','f1','image')
    addAsset(db,'movie','f1','video')
    db.query('UPDATE assets SET view_count = 8, vote_count = 2 WHERE id = ?').run('photo1')
    db.query('UPDATE assets SET view_count = 13, vote_count = 5 WHERE id = ?').run('photo2')
    db.query('UPDATE assets SET view_count = 50, vote_count = 9 WHERE id = ?').run('movie')
    createTag(db,'pt','shared',1,'image')
    createTag(db,'vt','shared',2,'video')
    addTagToAsset(db,'photo1','pt',1,'image')
    addTagToAsset(db,'photo2','pt',1,'image')
    addTagToAsset(db,'movie','vt',1,'video')
    for (let i=0;i<5;i++) {
      const photo = listTags(db, 'image')[0]!
      const video = listTags(db, 'video')[0]!
      expect(photo.assetCount).toBe(2)
      expect(photo.viewCount).toBe(21)
      expect(photo.voteCount).toBe(7)
      expect(['photo1','photo2']).toContain(photo.coverAssetId)
      expect(video.assetCount).toBe(1)
      expect(video.viewCount).toBe(50)
      expect(video.voteCount).toBe(9)
      expect(video.coverAssetId).toBe('movie')
    }
    db.close()
  })
})
