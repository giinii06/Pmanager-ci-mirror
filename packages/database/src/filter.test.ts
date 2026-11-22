import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  FIELD_SPECS,
  FILTER_FIELDS,
  FILTER_LIMITS,
  parseFilterTree,
  type AssetKind,
  type FilterField,
  type FilterNode,
  type FilterOperator,
  type FilterValue,
} from '@mediavault/shared'
import {
  compileFilter,
  computeAssetRates,
  createLibrary,
  createTag,
  addTagToAsset,
  createUser,
  insertAsset,
  listAssets,
  listMatchingAssetIds,
  openDatabase,
  pickRandomAsset,
  putProgress,
  replaceDuplicateGroups,
  upsertFolder,
  voteAsset,
  FilterCompileError,
  type AssetCursor,
  type CompiledFilter,
  type Db,
} from './index'

const cond = (field: FilterField, operator: FilterOperator, value: FilterValue): FilterNode => ({
  type: 'cond',
  field,
  operator,
  value,
})
const and = (...children: FilterNode[]): FilterNode => ({ type: 'and', children })
const or = (...children: FilterNode[]): FilterNode => ({ type: 'or', children })
const not = (child: FilterNode): FilterNode => ({ type: 'not', child })

interface SeedAsset {
  id: string
  libraryId: string
  folderId: string
  filename: string
  kind: AssetKind
  sizeBytes: number
  durationMs: number | null
  width: number | null
  height: number | null
  takenAt: number
  views: number
  watchTimeMs: number
  votes: number
}

const SEED: SeedAsset[] = [
  {
    id: 'a1', libraryId: 'lib1', folderId: 'f1', filename: '첫 번째 영상.mp4', kind: 'video',
    sizeBytes: 1000, durationMs: 60_000, width: 1920, height: 1080, takenAt: 1000,
    views: 10, watchTimeMs: 100_000, votes: 3,
  },
  {
    id: 'a2', libraryId: 'lib1', folderId: 'f1', filename: 'second.mp4', kind: 'video',
    sizeBytes: 2000, durationMs: 120_000, width: 1280, height: 720, takenAt: 2000,
    views: 5, watchTimeMs: 200_000, votes: 1,
  },
  {
    id: 'a3', libraryId: 'lib1', folderId: 'f2', filename: '셋째.jpg', kind: 'image',
    sizeBytes: 500, durationMs: null, width: 800, height: 600, takenAt: 3000,
    views: 0, watchTimeMs: 0, votes: 0,
  },
  {
    id: 'a4', libraryId: 'lib2', folderId: 'f3', filename: 'fourth.mp4', kind: 'video',
    sizeBytes: 4000, durationMs: 240_000, width: 3840, height: 2160, takenAt: 4000,
    views: 2, watchTimeMs: 50_000, votes: 0,
  },
  {
    id: 'a6', libraryId: 'lib1', folderId: 'f2', filename: 'sixth.mp4', kind: 'video',
    sizeBytes: 8000, durationMs: 300_000, width: 1920, height: 1080, takenAt: 5000,
    views: 0, watchTimeMs: 0, votes: 0,
  },
  {
    id: 'a8', libraryId: 'lib1', folderId: 'f1', filename: '100%_done.mp4', kind: 'video',
    sizeBytes: 9000, durationMs: 30_000, width: 640, height: 480, takenAt: 6000,
    views: 0, watchTimeMs: 0, votes: 0,
  },
  {
    id: 'a5', libraryId: 'lib1', folderId: 'f2', filename: 'deleted.mp4', kind: 'video',
    sizeBytes: 7000, durationMs: 60_000, width: 1920, height: 1080, takenAt: 7000,
    views: 4, watchTimeMs: 40_000, votes: 0,
  },
]

/** Every live asset, in id order. `a5` is soft-deleted and must never appear. */
const LIVE = ['a1', 'a2', 'a3', 'a4', 'a6', 'a8']

function seed(db: Db): void {
  createUser(db, { id: 'u1', username: 'owner', passwordHash: 'h', createdAt: 1 })
  createUser(db, { id: 'u2', username: 'guest', passwordHash: 'h', createdAt: 1 })
  createLibrary(db, { id: 'lib1', name: 'Shows', rootPath: 'Shows', createdAt: 1 })
  createLibrary(db, { id: 'lib2', name: 'Movies', rootPath: 'Movies', createdAt: 1 })
  upsertFolder(db, {
    id: 'f1', libraryId: 'lib1', parentId: null, relativePath: 'Shows',
    name: 'Shows', depth: 0, scanId: 's1',
  })
  upsertFolder(db, {
    id: 'f2', libraryId: 'lib1', parentId: 'f1', relativePath: 'Shows/Korean',
    name: 'Korean', depth: 1, scanId: 's1',
  })
  upsertFolder(db, {
    id: 'f3', libraryId: 'lib2', parentId: null, relativePath: 'Movies',
    name: 'Movies', depth: 0, scanId: 's1',
  })

  for (const asset of SEED) {
    insertAsset(db, {
      id: asset.id,
      libraryId: asset.libraryId,
      folderId: asset.folderId,
      relativePath: asset.filename,
      filename: asset.filename,
      kind: asset.kind,
      mimeType: asset.kind === 'video' ? 'video/mp4' : 'image/jpeg',
      sizeBytes: asset.sizeBytes,
      mtimeMs: 1_000,
      width: asset.width,
      height: asset.height,
      durationMs: asset.durationMs,
      takenAt: asset.takenAt,
      videoCodec: null,
      audioCodec: null,
      container: asset.kind === 'video' ? 'mp4' : 'jpg',
      indexedAt: asset.takenAt,
      scanId: 's1',
    })
    db.query<null, [number, number, string]>(
      'UPDATE assets SET view_count = ?, watch_time_ms = ? WHERE id = ?',
    ).run(asset.views, asset.watchTimeMs, asset.id)
  }
  for (let index = 0; index < 3; index += 1) voteAsset(db, 'a1', 10 + index)
  voteAsset(db, 'a2', 20)
  db.query<null, []>("UPDATE assets SET deleted_at = 9999 WHERE id = 'a5'").run()

  createTag(db, 't1', 'Favourites', 1)
  createTag(db, 't2', 'Korean', 1)
  createTag(db, 't3', 'Photos', 1)
  createTag(db, 'p1', 'Photos', 1, 'image')
  for (const [tagId, assetId, kind] of [
    ['t1', 'a1', 'video'], ['t1', 'a2', 'video'],
    ['t2', 'a1', 'video'], ['t2', 'a6', 'video'],
    ['t3', 'a6', 'video'],
    ['p1', 'a3', 'image'],
  ] as const) {
    addTagToAsset(db, assetId, tagId, 1, kind)
  }

  putProgress(db, 'u1', 'a1', 5_000, 60_000, 1000, 1)
  putProgress(db, 'u1', 'a2', 5_000, 120_000, 2000, 1)
  putProgress(db, 'u2', 'a3', 0, 1, 3000, 1)

  db.query<null, []>(
    `INSERT INTO video_bookmarks (id, user_id, asset_id, position_ms, file_version, created_at, updated_at)
     VALUES ('b1', 'u1', 'a2', 1000, 1, 1, 1), ('b2', 'u2', 'a4', 2000, 1, 1, 1)`,
  ).run()

  replaceDuplicateGroups(
    db,
    'exact',
    [
      {
        fingerprint: 'sha256:1000:' + 'a'.repeat(64),
        members: [
          { assetId: 'a1', confidence: 1, sameInode: false },
          { assetId: 'a2', confidence: 1, sameInode: false },
        ],
      },
    ],
    100,
  )

  // The filter reads only (asset_id, file_version); the parent job row is what
  // each stage's own test covers, so the seed writes the artifact rows directly.
  db.exec('PRAGMA foreign_keys = OFF')
  db.exec(`INSERT INTO transcripts (
    id, job_id, asset_id, file_version, language, result_dir, plain_text,
    model_revision, aligner_revision, pipeline_version, created_at
  ) VALUES ('tr1', 'job-a1', 'a1', 1, 'ko', 'd', 'text', 'm', 'a', 'p', 1),
           ('tr2', 'job-a2', 'a2', 2, 'ko', 'd', 'text', 'm', 'a', 'p', 1)`)
  db.exec(`INSERT INTO translations (
    id, job_id, source_transcript_id, asset_id, file_version, source_language, target_language,
    plain_text, result_dir, model_id, model_revision, model_sha256, prompt_version,
    pipeline_version, created_at
  ) VALUES ('tl1', 'job-t2', 'tr2', 'a2', 1, 'en', 'ko', 'text', 'd', 'm', 'r', 's', '1', '1', 1)`)
  db.exec(`INSERT INTO video_scenes (
    id, job_id, asset_id, file_version, seq, start_ms, end_ms, model_sha256, pipeline_version, created_at
  ) VALUES ('sc1', 'job-s4', 'a4', 1, 0, 0, 1000, 'm', 'p', 1)`)
  db.exec(`INSERT INTO video_embeddings (
    id, job_id, asset_id, file_version, kind, chunk_index, text, model_sha256, pipeline_version,
    dimensions, vector, created_at
  ) VALUES ('em1', 'job-e1', 'a1', 1, 'title', 0, 't', 'm', 'p', 3, x'000000', 1)`)
  db.exec('PRAGMA foreign_keys = ON')

  db.query<null, []>(
    `INSERT INTO library_health (library_id, state, checked_at, consecutive_failures)
     VALUES ('lib1', 'ONLINE', 1, 0)`,
  ).run()
}

let db: Db

beforeEach(() => {
  db = openDatabase(':memory:')
  seed(db)
})

afterEach(() => {
  db.close()
})

function matched(root: FilterNode, userId: string | null = 'u1'): string[] {
  const where = compileFilter({ version: 1, root }, { userId })
  return listAssets(db, { where }, null, 100)
    .records.map((record) => record.id)
    .sort()
}

describe('filter compiler', () => {
  test('and, or and not compose without losing a branch', () => {
    expect(matched(and(cond('kind', 'eq', 'video'), cond('library', 'eq', 'lib1')))).toEqual([
      'a1', 'a2', 'a6', 'a8',
    ])
    expect(matched(or(cond('kind', 'eq', 'image'), cond('library', 'eq', 'lib2')))).toEqual([
      'a3', 'a4',
    ])
    expect(matched(not(cond('kind', 'eq', 'video')))).toEqual(['a3'])
    expect(
      matched(
        and(
          or(cond('library', 'eq', 'lib1'), cond('library', 'eq', 'lib2')),
          not(cond('kind', 'eq', 'image')),
          not(cond('name', 'contains', 'sixth')),
        ),
      ),
    ).toEqual(['a1', 'a2', 'a4', 'a8'])
  })

  test('a soft-deleted asset is outside every filter', () => {
    expect(matched(cond('library', 'eq', 'lib1'))).not.toContain('a5')
    expect(matched(not(cond('kind', 'eq', 'image')))).not.toContain('a5')
  })

  test('tag any, all and none read the video and photo join tables', () => {
    expect(matched(cond('tag', 'any', ['t1', 't3']))).toEqual(['a1', 'a2', 'a6'])
    expect(matched(cond('tag', 'all', ['t1', 't2']))).toEqual(['a1'])
    expect(matched(cond('tag', 'none', ['t1', 't3']))).toEqual(['a3', 'a4', 'a8'])
    expect(matched(cond('tag', 'any', ['t-missing']))).toEqual([])
    // A photo tag lives in its own namespace and still matches the same field.
    expect(matched(cond('tag', 'any', ['p1']))).toEqual(['a3'])
    expect(matched(cond('tag', 'any', ['t1', 'p1']))).toEqual(['a1', 'a2', 'a3'])
    expect(matched(cond('tag', 'none', ['p1']))).toEqual(['a1', 'a2', 'a4', 'a6', 'a8'])
  })

  test('kind, library and folder match their ids', () => {
    expect(matched(cond('kind', 'eq', 'image'))).toEqual(['a3'])
    expect(matched(cond('kind', 'in', ['image']))).toEqual(['a3'])
    expect(matched(cond('library', 'eq', 'lib2'))).toEqual(['a4'])
    expect(matched(cond('folder', 'eq', 'f1'))).toEqual(['a1', 'a2', 'a8'])
    expect(matched(cond('folder', 'in', ['f2']))).toEqual(['a3', 'a6'])
  })

  test('a filename search matches Korean text and escapes the LIKE wildcards', () => {
    expect(matched(cond('name', 'contains', '영상'))).toEqual(['a1'])
    expect(matched(cond('name', 'eq', 'second.mp4'))).toEqual(['a2'])
    // An unescaped `_` would match every filename with at least one character.
    expect(matched(cond('name', 'contains', '_'))).toEqual(['a8'])
    expect(matched(cond('name', 'contains', '100%'))).toEqual(['a8'])
  })

  test('numeric comparisons and ranges use the asset columns', () => {
    expect(matched(cond('sizeBytes', 'gt', 4000))).toEqual(['a6', 'a8'])
    expect(matched(cond('sizeBytes', 'between', [2000, 8000]))).toEqual(['a2', 'a4', 'a6'])
    expect(matched(cond('sizeBytes', 'lte', 1000))).toEqual(['a1', 'a3'])
    expect(matched(cond('durationMs', 'gt', 100_000))).toEqual(['a2', 'a4', 'a6'])
    expect(
      matched(and(cond('width', 'gte', 1920), cond('height', 'gte', 1080))),
    ).toEqual(['a1', 'a4', 'a6'])
    expect(matched(cond('indexedAt', 'gte', 5000))).toEqual(['a6', 'a8'])
    expect(matched(cond('viewCount', 'gt', 0))).toEqual(['a1', 'a2', 'a4'])
    expect(matched(cond('viewCount', 'eq', 0))).toEqual(['a3', 'a6', 'a8'])
    expect(matched(cond('watchTimeMs', 'gte', 100_000))).toEqual(['a1', 'a2'])
    expect(matched(cond('voteCount', 'gte', 3))).toEqual(['a1'])
  })

  test('rate agrees with the percentile the gallery displays', () => {
    const rates = computeAssetRates(db, ['a1', 'a2', 'a4'])
    expect(rates.get('a1')).toBe(16.7)
    expect(rates.get('a4')).toBe(50)
    expect(rates.get('a2')).toBe(83.3)

    for (const [id, rate] of rates) {
      expect(matched(cond('rate', 'eq', rate))).toEqual([id])
    }
    expect(matched(cond('rate', 'gt', 50))).toEqual(['a2'])
    expect(matched(cond('rate', 'between', [40, 60]))).toEqual(['a4'])
    expect(matched(cond('rate', 'isNull', true))).toEqual(['a3', 'a6', 'a8'])
    expect(matched(cond('rate', 'isNull', false))).toEqual(['a1', 'a2', 'a4'])
  })

  test('lastPlayedAt and bookmarked belong to one user', () => {
    expect(matched(cond('lastPlayedAt', 'gte', 1500))).toEqual(['a2'])
    expect(matched(cond('lastPlayedAt', 'lt', 1500))).toEqual(['a1'])
    expect(matched(cond('lastPlayedAt', 'isNull', true))).toEqual(['a3', 'a4', 'a6', 'a8'])
    expect(matched(cond('lastPlayedAt', 'gte', 0), 'u2')).toEqual(['a3'])
    expect(matched(cond('bookmarked', 'eq', true))).toEqual(['a2'])
    expect(matched(cond('bookmarked', 'eq', true), 'u2')).toEqual(['a4'])
    expect(matched(cond('bookmarked', 'eq', false))).toEqual(['a1', 'a3', 'a4', 'a6', 'a8'])

    expect(() =>
      compileFilter({ version: 1, root: cond('bookmarked', 'eq', true) }, { userId: null }),
    ).toThrow(FilterCompileError)
    expect(() =>
      compileFilter({ version: 1, root: cond('lastPlayedAt', 'gt', 0) }, { userId: null }),
    ).toThrow(FilterCompileError)
  })

  test('duplicate and ai read the tables that hold the answer', () => {
    expect(matched(cond('duplicate', 'eq', 'exact'))).toEqual(['a1', 'a2'])
    expect(matched(cond('duplicate', 'neq', 'exact'))).toEqual(['a3', 'a4', 'a6', 'a8'])
    // Similar groups need perceptual hashing, so the honest answer is empty.
    expect(matched(cond('duplicate', 'eq', 'similar'))).toEqual([])

    expect(matched(cond('ai', 'eq', 'transcript:present'))).toEqual(['a1'])
    // a2's transcript is for file version 2; the asset is still at version 1.
    expect(matched(cond('ai', 'eq', 'transcript:absent'))).toEqual(['a2', 'a3', 'a4', 'a6', 'a8'])
    expect(matched(cond('ai', 'eq', 'translation:present'))).toEqual(['a2'])
    expect(matched(cond('ai', 'eq', 'scenes:present'))).toEqual(['a4'])
    expect(matched(cond('ai', 'eq', 'embedding:present'))).toEqual(['a1'])
    expect(matched(cond('ai', 'neq', 'scenes:present'))).toEqual(['a1', 'a2', 'a3', 'a6', 'a8'])
  })

  test('libraryHealth reports a library with no health row as UNVERIFIED', () => {
    expect(matched(cond('libraryHealth', 'eq', 'ONLINE'))).toEqual(['a1', 'a2', 'a3', 'a6', 'a8'])
    expect(matched(cond('libraryHealth', 'eq', 'UNVERIFIED'))).toEqual(['a4'])
    db.query<null, []>(
      `INSERT INTO library_health (library_id, state, checked_at, consecutive_failures)
       VALUES ('lib2', 'DEGRADED', 1, 1)`,
    ).run()
    expect(matched(cond('libraryHealth', 'eq', 'DEGRADED'))).toEqual(['a4'])
    expect(matched(cond('libraryHealth', 'in', ['ONLINE', 'DEGRADED']))).toEqual(LIVE)
  })

  test('every registered field and operator compiles to one placeholder per value', () => {
    for (const field of FILTER_FIELDS) {
      const spec = FIELD_SPECS[field]
      for (const operator of spec.operators) {
        const value = sampleValue(field, operator)
        const where = compileFilter({ version: 1, root: cond(field, operator, value) }, { userId: 'u1' })
        expect(where.sql.startsWith('(')).toBe(true)
        expect(where.sql.split('?').length - 1).toBe(where.params.length)
        expect(() => listAssets(db, { where }, null, 1)).not.toThrow()
      }
    }
  })
})

function sampleValue(field: FilterField, operator: FilterOperator): FilterValue {
  const spec = FIELD_SPECS[field]
  const scalar = (): string | number | boolean => {
    switch (spec.value) {
      case 'string':
        return spec.enum ? spec.enum[0]! : 'x'
      case 'number':
        return 1
      case 'boolean':
        return true
    }
  }
  switch (operator) {
    case 'between':
      return [0, 10]
    case 'in':
    case 'any':
    case 'all':
    case 'none': {
      const item = scalar()
      return typeof item === 'number' ? [item] : [String(item)]
    }
    case 'isNull':
      return true
    default:
      return scalar()
  }
}

describe('filter conformance', () => {
  // (A OR B) AND NOT C: the shape most likely to lose a branch in a count.
  const root = and(
    or(cond('library', 'eq', 'lib1'), cond('folder', 'eq', 'f3')),
    not(cond('kind', 'eq', 'image')),
  )
  const expected = ['a1', 'a2', 'a4', 'a6', 'a8']

  function pageAll(where: CompiledFilter): { ids: string[]; total: number } {
    const ids: string[] = []
    let total = 0
    for (let offset = 0; ; offset += 2) {
      const cursor: AssetCursor = { offset }
      const page = listAssets(db, { where }, cursor, 2)
      total = page.total
      ids.push(...page.records.map((record) => record.id))
      if (!page.hasMore) return { ids: ids.sort(), total }
    }
  }

  test('the count, the paginated ids and the id list all describe one set', () => {
    const where = compileFilter({ version: 1, root }, { userId: 'u1' })
    const paged = pageAll(where)
    expect(paged.total).toBe(expected.length)
    expect(paged.ids).toEqual(expected)
    expect(listMatchingAssetIds(db, { where }).sort()).toEqual(expected)
  })

  test('a random draw never leaves the filter and reaches both branches', () => {
    const where = compileFilter({ version: 1, root }, { userId: 'u1' })
    const drawn = new Set<string>()
    for (let seed = 0; seed < 200; seed += 1) {
      const asset = pickRandomAsset(db, { where }, { seed })
      expect(asset).not.toBeNull()
      expect(expected).toContain(asset!.id)
      drawn.add(asset!.id)
    }
    expect(drawn.has('a4')).toBe(true)
    expect([...drawn].some((id) => id !== 'a4')).toBe(true)
  })
})

describe('parseFilterTree', () => {
  const tree = (root: unknown): unknown => ({ version: 1, root })

  test('accepts a tree the compiler can build', () => {
    const parsed = parseFilterTree(
      tree(and(cond('tag', 'all', ['t1', 't2']), not(cond('sizeBytes', 'between', [1, 2])))),
    )
    expect(parsed.ok).toBe(true)
  })

  test('rejects an unknown field, operator, key and version', () => {
    expect(parseFilterTree(tree(cond('nope' as FilterField, 'eq', 1))).ok).toBe(false)
    expect(parseFilterTree(tree(cond('sizeBytes', 'contains' as FilterOperator, 1))).ok).toBe(false)
    expect(parseFilterTree(tree({ type: 'and', children: [], extra: 1 })).ok).toBe(false)
    expect(parseFilterTree({ version: 2, root: cond('kind', 'eq', 'video') }).ok).toBe(false)
  })

  test('rejects a wrong value shape and a non-finite number', () => {
    expect(parseFilterTree(tree(cond('sizeBytes', 'gt', 'big'))).ok).toBe(false)
    expect(parseFilterTree(tree(cond('sizeBytes', 'gt', Number.POSITIVE_INFINITY))).ok).toBe(false)
    expect(parseFilterTree(tree(cond('sizeBytes', 'between', [1]))).ok).toBe(false)
    expect(parseFilterTree(tree(cond('tag', 'any', []))).ok).toBe(false)
    expect(parseFilterTree(tree(cond('kind', 'eq', 'audio' as string))).ok).toBe(false)
    expect(parseFilterTree(tree(cond('rate', 'isNull', 1 as unknown as boolean))).ok).toBe(false)
  })

  test('rejects an empty group, too much nesting, too many nodes and a long list', () => {
    expect(parseFilterTree(tree({ type: 'and', children: [] })).ok).toBe(false)

    let deep: FilterNode = cond('kind', 'eq', 'video')
    for (let index = 0; index < FILTER_LIMITS.depth; index += 1) deep = not(deep)
    expect(parseFilterTree(tree(deep)).ok).toBe(false)
    let shallow: FilterNode = cond('kind', 'eq', 'video')
    for (let index = 0; index < FILTER_LIMITS.depth - 1; index += 1) shallow = not(shallow)
    expect(parseFilterTree(tree(shallow)).ok).toBe(true)

    const many = Array.from({ length: FILTER_LIMITS.nodes }, () => cond('kind', 'eq', 'video'))
    expect(parseFilterTree(tree({ type: 'and', children: many })).ok).toBe(false)

    const long = Array.from({ length: FILTER_LIMITS.list + 1 }, (_, index) => `t${index}`)
    expect(parseFilterTree(tree(cond('tag', 'any', long))).ok).toBe(false)
  })
})
