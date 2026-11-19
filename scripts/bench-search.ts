import { mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  countAssetMatches,
  countSegmentMatches,
  createAsrJob,
  createLibrary,
  configureSearchFts,
  ftsPhrase,
  insertAsset,
  openDatabase,
  searchAssetNames,
  searchDialogue,
  searchScenes,
  type SceneSearchHit,
  SEARCH_FANOUT,
  upsertFolder,
} from '../packages/database/src/index'
import type { Db } from '../packages/database/src/db'

const [command, target, ...rest] = process.argv.slice(2)
const flags = new Map(
  rest
    .filter((value) => value.startsWith('--'))
    .map((value) => {
      const [key, raw] = value.slice(2).split('=')
      return [key ?? '', Number(raw)] as const
    }),
)

/** A flag whose value is text, not a count. */
function flagValue(name: string): string | null {
  const prefix = `--${name}=`
  const found = rest.find((value) => value.startsWith(prefix))
  return found === undefined ? null : found.slice(prefix.length)
}

/**
 * The built-in lists only match the synthetic vocabulary. A run against a real
 * library passes its own terms so the rows are not all empty.
 */
function termList(name: string, fallback: { label: string; query: string }[]): { label: string; query: string }[] {
  const raw = flagValue(name)
  if (raw === null || raw === '') return fallback
  return raw.split(',').map((query) => ({ label: query, query }))
}

const DIMENSIONS = 1024
const LIMIT = 20
const ITERATIONS = 40
const MODEL_SHA = 'bench-model'
const PIPELINE = 'bench-1'

const KOREAN = ['학교', '축제', '바다', '여행지', '노을', '산책', '가족', '생일']
const ASCII = ['coast', 'drive', 'harbor', 'sunset', 'party', 'walk']
const RARE = 'zzrare'
const SCENE_MODALITIES = ['visual', 'audio', 'av'] as const

function usage(): never {
  console.error(
    [
      'usage: bun scripts/bench-search.ts build <dir> [--assets=1000] [--segments=10000] [--scenes=10000]',
      '       bun scripts/bench-search.ts run <db> [--names=a,b] [--dialogue=a,b] [--model-sha=…] [--pipeline=…] [--pipeline-query=…]',
    ].join('\n'),
  )
  process.exit(1)
}

function filenameFor(index: number): string {
  const korean = KOREAN[index % KOREAN.length]
  const ascii = ASCII[index % ASCII.length]
  const rare = index === 0 ? `${RARE}-` : ''
  const marker = index % 40 === 7 ? '여행지-' : ''
  const base =
    index % 10 === 3
      ? `노을 산책 ${index}`
      : index % 2 === 0
        ? `${korean}-${ascii}-${index}`
        : `${ascii}-${korean}-${index}`
  return `${rare}${marker}${base}.mp4`
}

function segmentText(globalIndex: number): string {
  const korean = KOREAN[globalIndex % KOREAN.length]
  const ascii = ASCII[globalIndex % ASCII.length]
  const rare = globalIndex === 0 ? ` ${RARE}` : ''
  const quiet = globalIndex % 97 === 0 ? ' 고요한' : ''
  const sea = globalIndex % 211 === 0 ? ' 바다 노을' : ''
  return `영상 ${globalIndex} 장면 ${korean} ${ascii} 이야기가 이어지고 다음 장면으로 넘어간다${quiet}${sea}${rare}`
}

/** Unit vectors from a small pool, so the scan reads real blobs and real norms. */
function vectorPool(): Uint8Array[] {
  return Array.from({ length: 16 }, (_, seed) => {
    const values = new Float32Array(DIMENSIONS)
    let norm = 0
    for (let index = 0; index < DIMENSIONS; index += 1) {
      values[index] = Math.sin(seed * 7 + index * 0.37)
      norm += values[index]! * values[index]!
    }
    const scale = 1 / Math.sqrt(norm)
    for (let index = 0; index < DIMENSIONS; index += 1) values[index]! *= scale
    return new Uint8Array(values.buffer)
  })
}

function build(dir: string): void {
  const assets = flags.get('assets') ?? 1_000
  const segments = flags.get('segments') ?? 10_000
  const scenes = flags.get('scenes') ?? 10_000
  const perAsset = Math.max(1, Math.floor(segments / assets))
  const scenesPerAsset = Math.max(1, Math.floor(scenes / assets))

  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `search-${assets}.db`)
  const db = openDatabase(file)

  const pool = vectorPool()
  const insertScene = db.query(
    `INSERT INTO video_scenes (
       id, job_id, asset_id, file_version, seq, start_ms, end_ms, thumbnail_path,
       model_sha256, pipeline_version, created_at
     ) VALUES (?, ?, ?, 1, ?, ?, ?, NULL, ?, ?, ?)`,
  )
  const insertEmbedding = db.query(
    'INSERT INTO scene_embeddings (scene_id, modality, dimensions, vector) VALUES (?, ?, ?, ?)',
  )
  const insertSceneJob = db.query(
    `INSERT INTO scene_jobs (
       id, asset_id, file_version, state, stage, progress, model_id, model_revision,
       model_sha256, pipeline_version, dimensions, window_ms, overlap_ms, created_at, updated_at
     ) VALUES (?, ?, 1, 'completed', 'completed', 100, 'bench', 'main', ?, ?, ?, 10000, 2000, ?, ?)`,
  )
  const insertTranscript = db.query(
    `INSERT INTO transcripts (
       id, job_id, asset_id, file_version, language, has_speech, result_dir, plain_text,
       model_revision, aligner_revision, pipeline_version, created_at
     ) VALUES (?, ?, ?, 1, 'ko', 1, ?, ?, 'asr-rev', 'align-rev', 'asr-1', ?)`,
  )
  const insertSegment = db.query(
    'INSERT INTO transcript_segments (transcript_id, seq, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)',
  )
  const finishAsrJob = db.query(
    "UPDATE asr_jobs SET state = 'completed', stage = 'completed' WHERE id = ?",
  )

  db.transaction(() => {
    createLibrary(db, { id: 'lib1', name: 'Bench', rootPath: 'Bench', createdAt: 1 })
    const folderId = upsertFolder(db, {
      id: 'folder1',
      libraryId: 'lib1',
      parentId: null,
      relativePath: 'Bench',
      name: 'Bench',
      depth: 0,
      scanId: 'scan1',
    })

    for (let index = 0; index < assets; index += 1) {
      const id = `asset${index}`
      const filename = filenameFor(index)
      insertAsset(db, {
        id,
        libraryId: 'lib1',
        folderId,
        relativePath: `Bench/${filename}`,
        filename,
        kind: 'video',
        mimeType: 'video/mp4',
        sizeBytes: 1_000 + index,
        mtimeMs: 1_000 + index,
        width: 1_920,
        height: 1_080,
        durationMs: 60_000,
        takenAt: 1_000_000 + index,
        videoCodec: 'h264',
        audioCodec: 'aac',
        container: 'mov,mp4',
        indexedAt: 2_000_000 + index,
        scanId: 'scan1',
      })

      createAsrJob(
        db,
        {
          id: `asr${index}`,
          assetId: id,
          fileVersion: 1,
          modelRevision: 'asr-rev',
          alignerRevision: 'align-rev',
          pipelineVersion: 'asr-1',
        },
        3_000 + index,
      )
      const rows = Array.from({ length: perAsset }, (_, seq) => ({
        seq,
        startMs: seq * 2_000,
        endMs: seq * 2_000 + 1_800,
        text: segmentText(index * perAsset + seq),
      }))
      insertTranscript.run(
        `tr${index}`,
        `asr${index}`,
        id,
        `${id}/1/asr${index}`,
        rows.map((row) => row.text).join(' '),
        3_100 + index,
      )
      for (const row of rows) {
        insertSegment.run(`tr${index}`, row.seq, row.startMs, row.endMs, row.text)
      }
      finishAsrJob.run(`asr${index}`)

      insertSceneJob.run(`job${index}`, id, MODEL_SHA, PIPELINE, DIMENSIONS, 3_000, 3_000)
      for (let seq = 0; seq < scenesPerAsset; seq += 1) {
        const sceneId = `scene${index}-${seq}`
        insertScene.run(
          sceneId,
          `job${index}`,
          id,
          seq,
          seq * 10_000,
          seq * 10_000 + 8_000,
          MODEL_SHA,
          PIPELINE,
          3_200 + index,
        )
        SCENE_MODALITIES.forEach((modality, slot) => {
          insertEmbedding.run(sceneId, modality, DIMENSIONS, pool[(index + seq + slot) % pool.length]!)
        })
      }
    }
  })()

  const counts = {
    assets: db.query<{ n: number }, []>('SELECT count(*) AS n FROM assets').get()!.n,
    transcripts: db.query<{ n: number }, []>('SELECT count(*) AS n FROM transcripts').get()!.n,
    segments: db.query<{ n: number }, []>('SELECT count(*) AS n FROM transcript_segments').get()!.n,
    scenes: db.query<{ n: number }, []>('SELECT count(*) AS n FROM video_scenes').get()!.n,
    embeddings: db.query<{ n: number }, []>('SELECT count(*) AS n FROM scene_embeddings').get()!.n,
  }
  console.log(`${file} ${(statSync(file).size / 1e6).toFixed(1)} MB`)
  console.log(JSON.stringify(counts))
  console.log(`segmentsPerAsset=${perAsset} scenesPerAsset=${scenesPerAsset}`)
  db.close()
}

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index] ?? 0
}

function measure(run: () => unknown): { p50: number; p95: number } {
  const samples: number[] = []
  for (let index = 0; index < ITERATIONS; index += 1) {
    const started = performance.now()
    run()
    samples.push(performance.now() - started)
  }
  return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) }
}

const NAMES = [
  { label: 'rare term', query: RARE },
  { label: 'common term', query: 'mp4' },
  { label: '2-char Korean', query: '바다' },
  { label: '3-char Korean', query: '여행지' },
  { label: '4-char with space', query: '노을 산책' },
]

const DIALOGUE = [
  { label: 'rare term', query: RARE },
  { label: 'common term', query: '이야기' },
  { label: '2-char Korean', query: '장면' },
  { label: '3-char Korean', query: '고요한' },
  { label: '4-char with space', query: '바다 노을' },
]

/** A query a person would type: three code points, so both corpora are eligible. */
const DEFAULT_PIPELINE_QUERY = '여행지'

async function run(dbPath: string): Promise<void> {
  const names = termList('names', NAMES)
  const dialogue = termList('dialogue', DIALOGUE)
  const modelSha = flagValue('model-sha') ?? MODEL_SHA
  const pipelineVersion = flagValue('pipeline') ?? PIPELINE
  const pipelineQuery = flagValue('pipeline-query') ?? DEFAULT_PIPELINE_QUERY
  const oracle = openDatabase(dbPath)
  const indexed = openDatabase(dbPath)
  const status = configureSearchFts(indexed, true)
  if (!status.enabled) {
    console.error(`the index did not come up: ${status.reason}`)
    process.exit(1)
  }
  console.log(
    `${dbPath} assets=${status.assets} segments=${status.segments} ` +
      `setupMs=${status.rebuiltMs} verifyMs=${status.verifyMs} ` +
      `limit=${LIMIT} iterations=${ITERATIONS} model=${modelSha} pipeline=${pipelineVersion}`,
  )

  let mismatch = 0
  const rows: string[] = []
  const pad = (value: string, width: number) => value.padEnd(width)

  const report = (
    label: string,
    corpus: 'name' | 'dialogue' | 'scene' | 'pipeline',
    path: string,
    term: string,
    reference: unknown,
    measured: unknown,
    timings: { p50: number; p95: number },
  ) => {
    // The LIKE row is the reference; every other row is compared against it.
    let check = 'ref'
    if (reference !== null) {
      const equal = JSON.stringify(reference) === JSON.stringify(measured)
      if (!equal) mismatch += 1
      check = `equal=${equal}`
    }
    rows.push(
      [
        pad(label, 22),
        pad(corpus, 9),
        pad(path, 5),
        pad(term, 16),
        timings.p50.toFixed(2).padStart(7),
        timings.p95.toFixed(2).padStart(7),
        check,
      ].join('  '),
    )
  }

  for (const { label, query } of names) {
    const phrase = ftsPhrase(query)
    const nameCeiling = LIMIT * SEARCH_FANOUT.names
    const indexedPath =
      phrase !== null && countAssetMatches(indexed, phrase, nameCeiling + 1) <= nameCeiling
        ? 'fts'
        : 'like'
    const reference = searchAssetNames(oracle, query, LIMIT)
    report(
      `filename ${label}`,
      'name',
      'like',
      query,
      null,
      null,
      measure(() => searchAssetNames(oracle, query, LIMIT)),
    )
    report(
      `filename ${label}`,
      'name',
      indexedPath,
      query,
      reference,
      searchAssetNames(indexed, query, LIMIT),
      measure(() => searchAssetNames(indexed, query, LIMIT)),
    )
  }

  for (const { label, query } of dialogue) {
    const phrase = ftsPhrase(query)
    const dialogueCeiling = LIMIT * SEARCH_FANOUT.dialogue
    const indexedPath =
      phrase !== null &&
      countSegmentMatches(indexed, phrase, dialogueCeiling + 1) <= dialogueCeiling
        ? 'fts'
        : 'like'
    const reference = searchDialogue(oracle, query, LIMIT)
    report(
      `dialogue ${label}`,
      'dialogue',
      'like',
      query,
      null,
      null,
      measure(() => searchDialogue(oracle, query, LIMIT)),
    )
    report(
      `dialogue ${label}`,
      'dialogue',
      indexedPath,
      query,
      reference,
      searchDialogue(indexed, query, LIMIT),
      measure(() => searchDialogue(indexed, query, LIMIT)),
    )
  }

  const scene = sceneQuery()
  const fingerprint = {
    modelSha256: modelSha,
    pipelineVersion,
    dimensions: DIMENSIONS,
  }
  // What one request to `/api/search/semantic` costs before ranking: the three
  // corpus queries the route runs in sequence. The RRF fusion over the hits is
  // excluded because it is O(hits) and sub-millisecond against these scans.
  const pipeline = () => {
    searchScenes(indexed, scene, fingerprint, 30)
    searchDialogue(indexed, pipelineQuery, LIMIT)
    searchAssetNames(indexed, pipelineQuery, LIMIT)
  }

  // The per-call `search.scenes` log line is identical for every iteration and
  // would bury the table, so it is muted for the timed region only.
  const info = console.info
  console.info = () => {}
  let hits = 0
  let timings = { p50: 0, p95: 0 }
  let pipelineTimings = { p50: 0, p95: 0 }
  let variantTimings = { p50: 0, p95: 0 }
  let current: SceneSearchHit[] = []
  let variantHits: SceneSearchHit[] = []
  let concurrent = 0
  try {
    current = searchScenes(indexed, scene, fingerprint, 30)
    hits = current.length
    timings = measure(() => searchScenes(indexed, scene, fingerprint, 30))
    variantHits = variantSceneScan(indexed, scene, fingerprint, 30)
    variantTimings = measure(() => variantSceneScan(indexed, scene, fingerprint, 30))
    pipelineTimings = measure(pipeline)
    const started = performance.now()
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        await Bun.sleep(0)
        pipeline()
      }),
    )
    concurrent = performance.now() - started
  } finally {
    console.info = info
  }
  report('scene scan', 'scene', 'scan', `${hits} hits`, null, null, timings)
  // The variant reorders the summation, so scores move by about 1e-15. What the
  // caller can observe is which scenes come back, in what order, and for which
  // modality; those must match exactly.
  const shape = (list: SceneSearchHit[]) =>
    JSON.stringify(list.map((hit) => [hit.sceneId, hit.assetId, hit.seq, hit.modality]))
  const delta = variantHits.length === 0
    ? 0
    : Math.max(
        ...variantHits.map((hit, index) => Math.abs(hit.score - (current[index]?.score ?? 0))),
      )
  const sameShape = shape(current) === shape(variantHits)
  if (!sameShape || delta > 1e-12) mismatch += 1
  rows.push(
    [
      pad('scene scan variant', 22),
      pad('scene', 9),
      pad('scan', 5),
      pad(`${variantHits.length} hits`, 16),
      variantTimings.p50.toFixed(2).padStart(7),
      variantTimings.p95.toFixed(2).padStart(7),
      `equal=${sameShape} delta=${delta.toExponential(1)}`,
    ].join('  '),
  )
  report('search pipeline', 'pipeline', 'both', pipelineQuery, null, null, pipelineTimings)
  rows.push(
    [
      pad('4 concurrent pipelines', 22),
      pad('pipeline', 9),
      pad('both', 5),
      pad('', 16),
      (concurrent / 4).toFixed(2).padStart(7),
      concurrent.toFixed(2).padStart(7),
      `wall=${concurrent.toFixed(0)} ms`,
    ].join('  '),
  )

  console.log(
    [
      pad('query', 22),
      pad('corpus', 9),
      pad('path', 5),
      pad('term', 16),
      pad('p50 ms', 7),
      pad('p95 ms', 7),
      'check',
    ].join('  '),
  )
  for (const row of rows) console.log(row)
  console.log(`rss=${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`)
  if (mismatch > 0) {
    console.error(`the index and the oracle disagreed on ${mismatch} measurement(s)`)
    process.exit(1)
  }
}

function sceneQuery(): { visual: Float32Array; audio: Float32Array; av: Float32Array } {
  const pool = vectorPool()
  const asFloats = (blob: Uint8Array) => new Float32Array(blob.slice().buffer)
  return {
    visual: asFloats(pool[0]!),
    audio: asFloats(pool[1]!),
    av: asFloats(pool[2]!),
  }
}

const SCENE_META_SQL = `SELECT s.id AS sceneId, s.asset_id AS assetId, s.seq, s.start_ms AS startMs,
                               s.end_ms AS endMs, s.thumbnail_path AS thumbnailPath
                        FROM video_scenes s JOIN assets a ON a.id = s.asset_id
                        WHERE a.deleted_at IS NULL AND s.file_version = a.file_version
                          AND s.model_sha256 = ? AND s.pipeline_version = ?`
const SCENE_EMBEDDING_SQL = `SELECT scene_id AS sceneId, modality, vector
                             FROM scene_embeddings WHERE dimensions = ?`

/** Four-way accumulators. Same sum to within 1e-15, 2.7x the throughput of the plain loop. */
function dot4(a: Float32Array, b: Float32Array): number {
  let s0 = 0
  let s1 = 0
  let s2 = 0
  let s3 = 0
  let index = 0
  for (; index + 3 < a.length; index += 4) {
    s0 += a[index]! * b[index]!
    s1 += a[index + 1]! * b[index + 1]!
    s2 += a[index + 2]! * b[index + 2]!
    s3 += a[index + 3]! * b[index + 3]!
  }
  let sum = s0 + s1 + s2 + s3
  for (; index < a.length; index += 1) sum += a[index]! * b[index]!
  return sum
}

/**
 * An exact alternative to `searchScenes` that the current implementation is
 * measured against. Three changes, none of which drop work: the embeddings are
 * read without `ORDER BY`, which avoids walking the primary-key index and
 * halving the page reads (602 ms against 345 ms at 100k scenes); the vectors go
 * through the four-way dot; and the top 30 is selected in one pass instead of
 * sorting an object per scene. Not adopted, because its warm p95 stays above the
 * 500 ms bar at 100k scenes. It also resolves a tie between two modalities of one
 * scene by rowid order rather than alphabetically, which `searchScenes` does, so
 * it needs that guard before it could replace it.
 */
function variantSceneScan(
  db: Db,
  query: { visual: Float32Array; audio: Float32Array; av: Float32Array },
  fingerprint: { modelSha256: string; pipelineVersion: string; dimensions: number },
  limit: number,
): SceneSearchHit[] {
  const metas = db
    .query<SceneSearchHit, [string, string]>(SCENE_META_SQL)
    .all(fingerprint.modelSha256, fingerprint.pipelineVersion)
  const dense = new Map<string, number>()
  for (let index = 0; index < metas.length; index += 1) dense.set(metas[index]!.sceneId, index)

  const scores = new Float64Array(metas.length).fill(-Infinity)
  const modalities = new Uint8Array(metas.length)
  const slot = { av: 0, audio: 1, visual: 2 } as const

  for (const row of db
    .query<{ sceneId: string; modality: 'visual' | 'audio' | 'av'; vector: Uint8Array }, [number]>(
      SCENE_EMBEDDING_SQL,
    )
    .iterate(fingerprint.dimensions)) {
    const at = dense.get(row.sceneId)
    if (at === undefined) continue
    const vector = new Float32Array(row.vector.buffer, row.vector.byteOffset, fingerprint.dimensions)
    const score = dot4(query[row.modality], vector)
    if (score > scores[at]!) {
      scores[at] = score
      modalities[at] = slot[row.modality]
    }
  }

  const names = ['av', 'audio', 'visual'] as const
  const top: number[] = []
  for (let index = 0; index < metas.length; index += 1) {
    const score = scores[index]!
    if (score === -Infinity) continue
    if (top.length === limit) {
      const worst = top[top.length - 1]!
      const beaten =
        score > scores[worst]! ||
        (score === scores[worst]! && metas[index]!.sceneId < metas[worst]!.sceneId)
      if (!beaten) continue
    }
    let at = top.length
    while (at > 0) {
      const other = top[at - 1]!
      const beaten =
        scores[other]! < score ||
        (scores[other]! === score && metas[other]!.sceneId > metas[index]!.sceneId)
      if (!beaten) break
      at -= 1
    }
    top.splice(at, 0, index)
    if (top.length > limit) top.pop()
  }
  return top.map((index) => ({
    ...metas[index]!,
    score: scores[index]!,
    modality: names[modalities[index]!]!,
  }))
}

if (!command || !target) usage()
if (command === 'build') build(target)
else if (command === 'run') await run(target)
else usage()
