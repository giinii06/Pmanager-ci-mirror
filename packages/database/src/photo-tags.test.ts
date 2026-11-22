import { describe, expect, test } from 'bun:test'
import {
  addTagToAsset, createLibrary, createTag, deleteTag, findTagByName, getTag,
  insertAsset, listAssets, listTags, openDatabase, removeTagFromAsset, renameTag,
  upsertFolder,
} from './index'

describe('separate photo tag namespace', () => {
  test('photo and video can use the same name independently', () => {
    const db = openDatabase(':memory:')
    createTag(db, 'video-tag', 'favorite', 1)
    createTag(db, 'photo-tag', 'favorite', 2, 'image')
    expect(listTags(db, 'video').map((tag) => tag.id)).toEqual(['video-tag'])
    expect(listTags(db, 'image').map((tag) => tag.id)).toEqual(['photo-tag'])
    expect(findTagByName(db, 'favorite', 'image')?.id).toBe('photo-tag')
    expect(getTag(db, 'photo-tag', 'video')).toBeNull()
    renameTag(db, 'photo-tag', 'portrait', 'image')
    expect(getTag(db, 'video-tag')?.name).toBe('favorite')
    expect(getTag(db, 'photo-tag', 'image')?.name).toBe('portrait')
    expect(deleteTag(db, 'photo-tag', 'video')).toBe(false)
    expect(deleteTag(db, 'photo-tag', 'image')).toBe(true)
    db.close()
  })

  test('photo assignments and filtering never expose video tags', () => {
    const db = openDatabase(':memory:')
    createLibrary(db, { id: 'lib', name: 'Library', rootPath: 'Library', createdAt: 1 })
    const folderId = upsertFolder(db, {
      id: 'folder', libraryId: 'lib', parentId: null, relativePath: '',
      name: 'Library', depth: 0, scanId: 'scan',
    })
    for (const kind of ['image', 'video'] as const) {
      insertAsset(db, {
        id: kind, libraryId: 'lib', folderId, relativePath: kind + '.jpg',
        filename: kind + '.jpg', kind, mimeType: 'image/jpeg',
        sizeBytes: 100, mtimeMs: 1, width: 64, height: 64, durationMs: null,
        takenAt: 100, videoCodec: null, audioCodec: null, container: null,
        indexedAt: 1, scanId: 'scan',
      })
    }
    createTag(db, 'v', 'same', 1)
    createTag(db, 'p', 'same', 1, 'image')
    addTagToAsset(db, 'image', 'p', 2, 'image')
    addTagToAsset(db, 'video', 'v', 2)
    addTagToAsset(db, 'image', 'v', 2)
    expect(listAssets(db, { kind: 'image', tagId: 'p' }, null, 10).records.map((a) => a.id)).toEqual(['image'])
    expect(listAssets(db, { kind: 'video', tagId: 'p' }, null, 10).records).toEqual([])
    expect(listAssets(db, { kind: 'image', tagId: 'v' }, null, 10).records).toEqual([])
    expect(listAssets(db, { kind: 'image' }, null, 10).records[0]?.tags.map((tag) => tag.id)).toEqual(['p'])
    expect(removeTagFromAsset(db, 'image', 'p', 'image')).toBe(true)
    expect(listAssets(db, { kind: 'image', tagId: 'p' }, null, 10).records).toEqual([])
    db.close()
  })
})
