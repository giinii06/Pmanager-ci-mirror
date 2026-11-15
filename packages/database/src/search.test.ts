import { describe, expect, test } from 'bun:test'
import {
  completeAsrJob,
  createAsrJob,
  createLibrary,
  insertAsset,
  openDatabase,
  searchAssetNames,
  searchDialogue,
  upsertFolder,
} from './index'
import type { Db } from './db'
import type { NewAsset } from './assets'

function assetInput(id: string, folderId: string, filename: string): NewAsset {
  return {
    id,
    libraryId: 'lib1',
    folderId,
    relativePath: `Videos/${filename}`,
    filename,
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 1_000,
    mtimeMs: 1_000,
    width: 1_080,
    height: 1_920,
    durationMs: 30_000,
    takenAt: 10_000,
    videoCodec: 'h264',
    audioCodec: 'aac',
    container: 'mov,mp4',
    indexedAt: 20_000,
    scanId: 'scan1',
  }
}

function seed(): Db {
  const db = openDatabase(':memory:')
  createLibrary(db, { id: 'lib1', name: 'Videos', rootPath: 'Videos', createdAt: 1 })
  const folderId = upsertFolder(db, {
    id: 'folder1',
    libraryId: 'lib1',
    parentId: null,
    relativePath: 'Videos',
    name: 'Videos',
    depth: 0,
    scanId: 'scan1',
  })
  insertAsset(db, assetInput('asset1', folderId, '학교 축제.mp4'))
  insertAsset(db, assetInput('asset2', folderId, 'coast-drive.mp4'))
  return db
}

function transcribe(db: Db, assetId: string, jobId: string, text: string, at: number): void {
  createAsrJob(
    db,
    {
      id: jobId,
      assetId,
      fileVersion: 1,
      modelRevision: 'asr-rev',
      alignerRevision: 'align-rev',
      pipelineVersion: 'asr-pipeline',
    },
    at,
  )
  completeAsrJob(
    db,
    {
      jobId,
      transcriptId: `tr-${jobId}`,
      resultDir: `${assetId}/1/${jobId}`,
      plainText: text,
      language: 'ko',
      segments: [{ seq: 0, startMs: 1_000, endMs: 3_000, text }],
    },
    at + 100,
  )
}

describe('dialogue search', () => {
  test('a two-character Korean word matches', () => {
    const db = seed()
    transcribe(db, 'asset1', 'asr1', '오늘 학교에 갔다', 2_000)

    const hits = searchDialogue(db, '학교', 10)

    expect(hits).toHaveLength(1)
    expect(hits[0]?.assetId).toBe('asset1')
    expect(hits[0]?.startMs).toBe(1_000)
  })

  test('only the newest transcript of the current file version is searched', () => {
    const db = seed()
    transcribe(db, 'asset1', 'asr1', '옛날 학교', 2_000)
    transcribe(db, 'asset1', 'asr2', '새로운 바다', 4_000)

    expect(searchDialogue(db, '학교', 10)).toHaveLength(0)
    expect(searchDialogue(db, '바다', 10)).toHaveLength(1)
  })

  test('a deleted asset is not searched', () => {
    const db = seed()
    transcribe(db, 'asset1', 'asr1', '오늘 학교에 갔다', 2_000)
    db.query('UPDATE assets SET deleted_at = 9_000 WHERE id = ?').run('asset1')

    expect(searchDialogue(db, '학교', 10)).toHaveLength(0)
  })

  test('a percent sign is a literal, not a wildcard', () => {
    const db = seed()
    transcribe(db, 'asset1', 'asr1', '성장률 5% 달성', 2_000)

    expect(searchDialogue(db, '5%', 10)).toHaveLength(1)
    expect(searchDialogue(db, '%', 10)).toHaveLength(1)
    expect(searchDialogue(db, '5_', 10)).toHaveLength(0)
  })

  test('an underscore is a literal too', () => {
    const db = seed()
    transcribe(db, 'asset1', 'asr1', 'a_b 패턴', 2_000)

    expect(searchDialogue(db, 'a_b', 10)).toHaveLength(1)
    expect(searchDialogue(db, 'aXb', 10)).toHaveLength(0)
  })
})

describe('filename search', () => {
  test('a partial name matches and carries the kind', () => {
    const db = seed()

    const hits = searchAssetNames(db, 'coast', 10)

    expect(hits).toHaveLength(1)
    expect(hits[0]?.assetId).toBe('asset2')
    expect(hits[0]?.kind).toBe('video')
    expect(hits[0]?.durationMs).toBe(30_000)
  })

  test('a Korean partial name matches', () => {
    const db = seed()

    expect(searchAssetNames(db, '축제', 10)).toHaveLength(1)
  })

  test('the limit is respected', () => {
    const db = seed()
    insertAsset(db, assetInput('asset3', 'folder1', 'coast-night.mp4'))

    expect(searchAssetNames(db, 'coast', 1)).toHaveLength(1)
  })
})
