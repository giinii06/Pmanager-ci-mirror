import { describe, expect, test } from 'bun:test'
import {
  commitPermanentDelete,
  completeAsrJob,
  configureSearchFts,
  countAssetMatches,
  countSegmentMatches,
  createAsrJob,
  createLibrary,
  ftsPhrase,
  insertAsset,
  openDatabase,
  searchAssetNames,
  searchDialogue,
  searchFtsReady,
  updateAssetFile,
  upsertFolder,
} from './index'
import type { Db } from './db'
import type { NewAsset } from './assets'

const FILENAMES = [
  '학교 축제.mp4',
  'coast-drive.mp4',
  'COAST-Night.mp4',
  '성장률 5% 달성.mp4',
  'a_b 패턴.mp4',
  'say "hello".mp4',
  'a\\b 경로.mp4',
  '😀학교 축제.mp4',
  '학교 축제.mp4',
]

const CAP = 10_000

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

function transcribe(db: Db, assetId: string, index: number, text: string, at: number): void {
  createAsrJob(
    db,
    {
      id: `asr${index}`,
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
      jobId: `asr${index}`,
      transcriptId: `tr${index}`,
      resultDir: `${assetId}/1/asr${index}`,
      plainText: text,
      language: 'ko',
      segments: [{ seq: 0, startMs: 1_000, endMs: 3_000, text }],
    },
    at + 100,
  )
}

/** Every asset gets a transcript holding the same text, so one query hits both corpora. */
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
  FILENAMES.forEach((filename, index) => {
    const id = `asset${index}`
    insertAsset(db, assetInput(id, folderId, filename))
    transcribe(db, id, index, filename, 2_000 + index)
  })
  return db
}

/** The same rows, one handle with the trigram index and one without. */
function pair(): { indexed: Db; oracle: Db } {
  const indexed = seed()
  configureSearchFts(indexed, true)
  return { indexed, oracle: seed() }
}

const QUERIES = [
  '학',
  '학교',
  '학교에',
  '학교 축제',
  'coast',
  'COAST',
  'Coast',
  '5%',
  '률 5%',
  'a_b',
  '_',
  'a\\b',
  '\\',
  '%',
  'say "h',
  'say "hello"',
  '😀학',
  '😀학교',
  '학교',
]

describe('the trigram path and the LIKE oracle', () => {
  test('return the same ordered filename rows for every query shape', () => {
    const { indexed, oracle } = pair()

    for (const query of QUERIES) {
      const fromIndex = searchAssetNames(indexed, query, 10)
      expect({ query, hits: fromIndex }).toEqual({ query, hits: searchAssetNames(oracle, query, 10) })
    }
  })

  test('return the same ordered dialogue rows for every query shape', () => {
    const { indexed, oracle } = pair()

    for (const query of QUERIES) {
      const fromIndex = searchDialogue(indexed, query, 10)
      expect({ query, hits: fromIndex }).toEqual({ query, hits: searchDialogue(oracle, query, 10) })
    }
  })

  test('the fixture actually matches, so agreement is not empty against empty', () => {
    const { indexed } = pair()

    expect(searchAssetNames(indexed, '학교 축제', 10).map((hit) => hit.filename)).toEqual([
      '😀학교 축제.mp4',
      '학교 축제.mp4',
    ])
    expect(searchAssetNames(indexed, 'COAST', 10)).toHaveLength(2)
    expect(searchAssetNames(indexed, 'a_b', 10)).toHaveLength(1)
    expect(searchAssetNames(indexed, '%', 10)).toHaveLength(1)
    expect(searchAssetNames(indexed, '_', 10)).toHaveLength(1)
    expect(searchAssetNames(indexed, '\\', 10)).toHaveLength(1)
    expect(searchAssetNames(indexed, '😀학', 10)).toHaveLength(1)
    expect(searchAssetNames(indexed, '학교', 10)).toHaveLength(1)
  })

  test('a query shorter than three code points never consults the index', () => {
    const { indexed } = pair()
    indexed.exec("INSERT INTO asset_search(asset_search) VALUES ('delete-all')")

    expect(searchAssetNames(indexed, '학교', 10)).toHaveLength(2)
    expect(searchAssetNames(indexed, '학교 축제', 10)).toHaveLength(0)
  })

  test('the limit and the order hold on both paths', () => {
    const { indexed, oracle } = pair()

    expect(searchAssetNames(indexed, 'COAST', 1)).toHaveLength(1)
    expect(searchAssetNames(indexed, 'COAST', 1)).toEqual(searchAssetNames(oracle, 'COAST', 1))
  })
})

describe('dialogue ordering is part of the contract', () => {
  test('the newest transcript comes first and the sequence breaks ties', () => {
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
    const oracle = openDatabase(':memory:')
    createLibrary(oracle, { id: 'lib1', name: 'Videos', rootPath: 'Videos', createdAt: 1 })
    upsertFolder(oracle, {
      id: 'folder1',
      libraryId: 'lib1',
      parentId: null,
      relativePath: 'Videos',
      name: 'Videos',
      depth: 0,
      scanId: 'scan1',
    })

    for (const [target, at] of [
      [db, 1_000],
      [oracle, 1_000],
    ] as const) {
      ;['asset0', 'asset1', 'asset2'].forEach((id, index) => {
        insertAsset(target, assetInput(id, folderId, `${id}-여행지.mp4`))
        createAsrJob(
          target,
          {
            id: `asr${index}`,
            assetId: id,
            fileVersion: 1,
            modelRevision: 'asr-rev',
            alignerRevision: 'align-rev',
            pipelineVersion: 'asr-pipeline',
          },
          at + index,
        )
        completeAsrJob(
          target,
          {
            jobId: `asr${index}`,
            transcriptId: `tr${index}`,
            resultDir: `${id}/1/asr${index}`,
            plainText: '여행지 장면',
            language: 'ko',
            segments: [
              { seq: 0, startMs: 0, endMs: 1_000, text: '여행지 하나' },
              { seq: 1, startMs: 1_000, endMs: 2_000, text: '여행지 둘' },
            ],
          },
          at + index * 10,
        )
      })
    }
    configureSearchFts(db, true)

    const hits = searchDialogue(db, '여행지', 10)

    expect(hits.map((hit) => [hit.assetId, hit.seq])).toEqual([
      ['asset2', 0],
      ['asset2', 1],
      ['asset1', 0],
      ['asset1', 1],
      ['asset0', 0],
      ['asset0', 1],
    ])
    expect(hits).toEqual(searchDialogue(oracle, '여행지', 10))
  })
})

describe('the index follows the content tables', () => {
  test('a rename drops the old name and keeps the new one', () => {
    const { indexed } = pair()
    expect(searchAssetNames(indexed, 'coast', 10).map((hit) => hit.filename)).toContain(
      'coast-drive.mp4',
    )

    const renamed = updateAssetFile(indexed, 'asset1', {
      folderId: 'folder1',
      filename: 'harbor-drive.mp4',
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
      indexedAt: 30_000,
      scanId: 'scan1',
    })

    expect(renamed).toBe(true)
    expect(searchAssetNames(indexed, 'harbor', 10)).toHaveLength(1)
    expect(countAssetMatches(indexed, ftsPhrase('harbor-drive')!, CAP)).toBe(1)
    expect(countAssetMatches(indexed, ftsPhrase('coast-drive')!, CAP)).toBe(0)
  })

  test('a hard delete leaves no index row behind', () => {
    const { indexed } = pair()
    expect(countAssetMatches(indexed, ftsPhrase('학교 축제')!, CAP)).toBe(2)

    indexed.query('DELETE FROM assets WHERE id = ?').run('asset0')

    expect(countAssetMatches(indexed, ftsPhrase('학교 축제')!, CAP)).toBe(1)
    expect(searchAssetNames(indexed, '학교 축제', 10)).toHaveLength(1)
  })

  test('a soft delete keeps the index row and the predicate drops it', () => {
    const { indexed, oracle } = pair()
    indexed.query('UPDATE assets SET deleted_at = ? WHERE id = ?').run(9_000, 'asset0')
    oracle.query('UPDATE assets SET deleted_at = ? WHERE id = ?').run(9_000, 'asset0')

    expect(countAssetMatches(indexed, ftsPhrase('학교 축제')!, CAP)).toBe(2)
    expect(searchAssetNames(indexed, '학교 축제', 10).map((hit) => hit.assetId)).toEqual(['asset7'])
    expect(searchAssetNames(indexed, '학교 축제', 10)).toEqual(
      searchAssetNames(oracle, '학교 축제', 10),
    )
  })

  test('deleting a transcript cascades the segments out of the index', () => {
    const { indexed } = pair()
    expect(countSegmentMatches(indexed, ftsPhrase('학교 축제')!, CAP)).toBe(2)

    indexed.query('DELETE FROM transcripts WHERE id = ?').run('tr0')

    expect(countSegmentMatches(indexed, ftsPhrase('학교 축제')!, CAP)).toBe(1)
    expect(searchDialogue(indexed, '학교 축제', 10)).toHaveLength(1)
  })

  test('the triggers do not change what a mutation reports', () => {
    const { indexed } = pair()

    expect(commitPermanentDelete(indexed, 'asset1', 'lib1')).toBe(true)
    expect(commitPermanentDelete(indexed, 'asset1', 'lib1')).toBe(false)
    expect(countAssetMatches(indexed, ftsPhrase('coast-drive')!, CAP)).toBe(0)
  })
})

describe('readiness is a proof, not a guess', () => {
  test('an index that never saw the existing rows is rebuilt before it is trusted', () => {
    const db = seed()
    expect(searchFtsReady(db)).toBe(false)

    const status = configureSearchFts(db, true)

    expect(status.enabled).toBe(true)
    expect(status.assets).toBe(FILENAMES.length)
    expect(status.segments).toBe(FILENAMES.length)
    expect(searchFtsReady(db)).toBe(true)
    expect(countAssetMatches(db, ftsPhrase('학교 축제')!, CAP)).toBe(2)
    expect(searchAssetNames(db, '학교 축제', 10)).toHaveLength(2)
  })

  test('a row removed from the index is detected and repaired, never served short', () => {
    const { indexed } = pair()
    const target = indexed
      .query<{ rowid: number; text: string }, []>(
        "SELECT rowid, text FROM transcript_segments WHERE text LIKE '%학교 축제%' LIMIT 1",
      )
      .get()!

    indexed.exec(
      `INSERT INTO segment_search(segment_search, rowid, text)
       VALUES ('delete', ${target.rowid}, '${target.text}')`,
    )
    expect(countSegmentMatches(indexed, ftsPhrase('학교 축제')!, CAP)).toBe(1)

    const status = configureSearchFts(indexed, true)

    expect(status.enabled).toBe(true)
    expect(countSegmentMatches(indexed, ftsPhrase('학교 축제')!, CAP)).toBe(2)
    expect(searchDialogue(indexed, '학교 축제', 10)).toHaveLength(2)
  })

  test('running it twice changes nothing', () => {
    const db = seed()
    const first = configureSearchFts(db, true)
    const second = configureSearchFts(db, true)

    expect(second.enabled).toBe(true)
    expect(second.assets).toBe(first.assets)
    expect(second.segments).toBe(first.segments)
    expect(searchAssetNames(db, '학교 축제', 10)).toHaveLength(2)
    expect(countSegmentMatches(db, ftsPhrase('학교 축제')!, CAP)).toBe(2)
  })
})

describe('disabling is a real disable', () => {
  test('a database that never had an index disables cleanly', () => {
    const db = seed()

    const off = configureSearchFts(db, false)

    expect(off.enabled).toBe(false)
    expect(searchFtsReady(db)).toBe(false)
    expect(searchAssetNames(db, '학교 축제', 10)).toHaveLength(2)
  })

  test('it disarms the triggers so writes still land, and re-enabling repairs the index', () => {
    const db = seed()
    configureSearchFts(db, true)

    const off = configureSearchFts(db, false)

    expect(off.enabled).toBe(false)
    expect(searchFtsReady(db)).toBe(false)
    insertAsset(db, assetInput('asset9', 'folder1', '새로 들어온 영상.mp4'))
    expect(searchAssetNames(db, '새로 들어온', 10)).toHaveLength(1)
    expect(countAssetMatches(db, ftsPhrase('새로 들어온')!, CAP)).toBe(0)

    const on = configureSearchFts(db, true)

    expect(on.enabled).toBe(true)
    expect(countAssetMatches(db, ftsPhrase('새로 들어온')!, CAP)).toBe(1)
    expect(searchAssetNames(db, '새로 들어온', 10)).toHaveLength(1)
  })
})

describe('falling back to the oracle', () => {
  test('a plain table holding the index name disables the fast path', () => {
    const db = seed()
    db.exec('CREATE TABLE asset_search (filename TEXT)')

    const status = configureSearchFts(db, true)

    expect(status.enabled).toBe(false)
    expect(status.reason).toContain('asset_search')
    expect(searchFtsReady(db)).toBe(false)
    expect(searchAssetNames(db, '학교 축제', 10)).toHaveLength(2)
    expect(searchDialogue(db, '학교 축제', 10)).toHaveLength(2)
  })

  test('a handle that never ran the setup stays on LIKE', () => {
    const db = seed()

    expect(searchFtsReady(db)).toBe(false)
    expect(searchAssetNames(db, '학교 축제', 10)).toHaveLength(2)
    expect(searchDialogue(db, '학교 축제', 10)).toHaveLength(2)
  })
})

describe('ftsPhrase', () => {
  test('refuses a query the trigram tokenizer cannot hold', () => {
    expect(ftsPhrase('')).toBeNull()
    expect(ftsPhrase('학')).toBeNull()
    expect(ftsPhrase('학교')).toBeNull()
    expect(ftsPhrase('ab')).toBeNull()
    expect(ftsPhrase('😀학')).toBeNull()
    expect(ftsPhrase('a\u0000bc')).toBeNull()
    expect(ftsPhrase('ab\ncd')).toBeNull()
  })

  test('counts code points, so a surrogate pair is one character', () => {
    expect(ftsPhrase('😀학교')).toBe('"😀학교"')
  })

  test('quotes the term so no user text reaches the parser unquoted', () => {
    expect(ftsPhrase('학교에')).toBe('"학교에"')
    expect(ftsPhrase('say "hi"')).toBe('"say ""hi"""')
    expect(ftsPhrase('a_b%')).toBe('"a_b%"')
    expect(ftsPhrase('학교에 OR 5%')).toBe('"학교에 OR 5%"')
  })

  test('a control character is refused rather than stripped', () => {
    const db = seed()
    configureSearchFts(db, true)
    db.query('UPDATE transcript_segments SET text = ? WHERE transcript_id = ?').run(
      'ab\ncd 패턴',
      'tr0',
    )

    expect(searchDialogue(db, 'ab\ncd', 10)).toHaveLength(1)
  })
})
