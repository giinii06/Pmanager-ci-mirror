import {
  getScene,
  searchScenes,
  openDatabase,
  type SceneQueryVectors,
  type SceneSearchHit,
} from '../packages/database/src/index'
import type { Db } from '../packages/database/src/db'

const DIMENSIONS = 1024
const MODEL_SHA = 'bench-model'
const PIPELINE = 'bench-1'
const LIMIT = 30
const ITERATIONS = 20

function vectorPool(): Float32Array[] {
  return Array.from({ length: 16 }, (_, seed) => {
    const values = new Float32Array(DIMENSIONS)
    let norm = 0
    for (let index = 0; index < DIMENSIONS; index += 1) {
      values[index] = Math.sin(seed * 7 + index * 0.37)
      norm += values[index]! * values[index]!
    }
    const scale = 1 / Math.sqrt(norm)
    for (let index = 0; index < DIMENSIONS; index += 1) values[index]! *= scale
    return values
  })
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let index = 0; index < a.length; index += 1) sum += a[index]! * b[index]!
  return sum
}

function asFloats(bytes: Uint8Array, dimensions: number): Float32Array {
  if (bytes.byteOffset % 4 === 0 && bytes.byteLength === dimensions * 4) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, dimensions)
  }
  return new Float32Array(bytes.slice().buffer)
}

type Fingerprint = { modelSha256: string; pipelineVersion: string; dimensions: number }

/** Variant A: metadata into a Map first, then the embeddings scan ordered by scene id. */
function variantA(db: Db, query: SceneQueryVectors, f: Fingerprint, limit: number): SceneSearchHit[] {
  const scenes = new Map<string, Omit<SceneSearchHit, 'score' | 'modality'>>()
  for (const row of db
    .query<
      {
        sceneId: string
        assetId: string
        seq: number
        startMs: number
        endMs: number
        thumbnailPath: string | null
      },
      [string, string]
    >(
      `SELECT s.id AS sceneId, s.asset_id AS assetId, s.seq, s.start_ms AS startMs,
              s.end_ms AS endMs, s.thumbnail_path AS thumbnailPath
       FROM video_scenes s
       JOIN assets a ON a.id = s.asset_id
       WHERE a.deleted_at IS NULL
         AND s.file_version = a.file_version
         AND s.model_sha256 = ? AND s.pipeline_version = ?`,
    )
    .iterate(f.modelSha256, f.pipelineVersion)) {
    scenes.set(row.sceneId, row)
  }

  const best = new Map<string, SceneSearchHit>()
  for (const row of db
    .query<{ sceneId: string; modality: 'visual' | 'audio' | 'av'; vector: Uint8Array }, [number]>(
      `SELECT scene_id AS sceneId, modality, vector
       FROM scene_embeddings
       WHERE dimensions = ?
       ORDER BY scene_id, modality`,
    )
    .iterate(f.dimensions)) {
    const meta = scenes.get(row.sceneId)
    if (!meta) continue
    const score = dot(query[row.modality], asFloats(row.vector, f.dimensions))
    const previous = best.get(row.sceneId)
    if (!previous || score > previous.score) {
      best.set(row.sceneId, { ...meta, score, modality: row.modality })
    }
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.sceneId.localeCompare(b.sceneId))
    .slice(0, limit)
}

/** Variant B: dense parallel arrays, no Map and no per-row object. */
function variantB(db: Db, query: SceneQueryVectors, f: Fingerprint, limit: number): SceneSearchHit[] {
  const ids: string[] = []
  const assetIds: string[] = []
  const seqs: number[] = []
  const starts: number[] = []
  const ends: number[] = []
  const thumbs: (string | null)[] = []
  const dense = new Map<string, number>()

  for (const row of db
    .query<
      {
        sceneId: string
        assetId: string
        seq: number
        startMs: number
        endMs: number
        thumbnailPath: string | null
      },
      [string, string]
    >(
      `SELECT s.id AS sceneId, s.asset_id AS assetId, s.seq, s.start_ms AS startMs,
              s.end_ms AS endMs, s.thumbnail_path AS thumbnailPath
       FROM video_scenes s
       JOIN assets a ON a.id = s.asset_id
       WHERE a.deleted_at IS NULL
         AND s.file_version = a.file_version
         AND s.model_sha256 = ? AND s.pipeline_version = ?`,
    )
    .iterate(f.modelSha256, f.pipelineVersion)) {
    dense.set(row.sceneId, ids.length)
    ids.push(row.sceneId)
    assetIds.push(row.assetId)
    seqs.push(row.seq)
    starts.push(row.startMs)
    ends.push(row.endMs)
    thumbs.push(row.thumbnailPath)
  }

  const scores = new Float32Array(ids.length).fill(-Infinity)
  const modalities: ('visual' | 'audio' | 'av')[] = new Array(ids.length)
  for (const row of db
    .query<{ sceneId: string; modality: 'visual' | 'audio' | 'av'; vector: Uint8Array }, [number]>(
      `SELECT scene_id AS sceneId, modality, vector
       FROM scene_embeddings
       WHERE dimensions = ?
       ORDER BY scene_id, modality`,
    )
    .iterate(f.dimensions)) {
    const at = dense.get(row.sceneId)
    if (at === undefined) continue
    const score = dot(query[row.modality], asFloats(row.vector, f.dimensions))
    if (score > scores[at]!) {
      scores[at] = score
      modalities[at] = row.modality
    }
  }

  const order = Array.from({ length: ids.length }, (_, index) => index)
  order.sort((left, right) => scores[right]! - scores[left]! || ids[left]!.localeCompare(ids[right]!))
  return order.slice(0, limit).map((index) => ({
    sceneId: ids[index]!,
    assetId: assetIds[index]!,
    seq: seqs[index]!,
    startMs: starts[index]!,
    endMs: ends[index]!,
    thumbnailPath: thumbs[index]!,
    score: scores[index]!,
    modality: modalities[index]!,
  }))
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0
}

function measure(run: () => unknown, warmups = 3): { p50: number; p95: number } {
  for (let index = 0; index < warmups; index += 1) run()
  const samples: number[] = []
  for (let index = 0; index < ITERATIONS; index += 1) {
    const started = performance.now()
    run()
    samples.push(performance.now() - started)
  }
  return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) }
}

const dbPath = process.argv[2]
if (!dbPath) throw new Error('usage: bun scripts/exp-scene.ts <db>')
const db = openDatabase(dbPath)
const pool = vectorPool()
const query: SceneQueryVectors = { visual: pool[0]!, audio: pool[1]!, av: pool[2]! }
const fingerprint: Fingerprint = {
  modelSha256: MODEL_SHA,
  pipelineVersion: PIPELINE,
  dimensions: DIMENSIONS,
}

console.log(`scenes=${db.query<{ n: number }, []>('SELECT count(*) AS n FROM video_scenes').get()!.n} ` +
  `embeddings=${db.query<{ n: number }, []>('SELECT count(*) AS n FROM scene_embeddings').get()!.n}`)

const plans: { label: string; sql: string; params: (string | number)[] }[] = [
  {
    label: 'current join',
    sql: `SELECT s.id AS sceneId, s.asset_id AS assetId, s.seq, s.start_ms AS startMs,
            s.end_ms AS endMs, s.thumbnail_path AS thumbnailPath, e.modality, e.vector
     FROM scene_embeddings e
     JOIN video_scenes s ON s.id = e.scene_id
     JOIN assets a ON a.id = s.asset_id
     WHERE a.deleted_at IS NULL
       AND s.file_version = a.file_version
       AND s.model_sha256 = ? AND s.pipeline_version = ?
       AND e.dimensions = ?`,
    params: [fingerprint.modelSha256, fingerprint.pipelineVersion, fingerprint.dimensions],
  },
  {
    label: 'metadata only',
    sql: `SELECT s.id AS sceneId, s.asset_id AS assetId, s.seq, s.start_ms AS startMs,
            s.end_ms AS endMs, s.thumbnail_path AS thumbnailPath
     FROM video_scenes s
     JOIN assets a ON a.id = s.asset_id
     WHERE a.deleted_at IS NULL
       AND s.file_version = a.file_version
       AND s.model_sha256 = ? AND s.pipeline_version = ?`,
    params: [fingerprint.modelSha256, fingerprint.pipelineVersion],
  },
  {
    label: 'embeddings only',
    sql: `SELECT scene_id AS sceneId, modality, vector FROM scene_embeddings
     WHERE dimensions = ? ORDER BY scene_id, modality`,
    params: [fingerprint.dimensions],
  },
]
for (const { label, sql, params } of plans) {
  console.log(`\n--- ${label}`)
  for (const row of db.query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${sql}`).all(...params)) {
    console.log(`    ${row.detail}`)
  }
}

const info = console.info
console.info = () => {}
let reference: SceneSearchHit[] = []
try {
  reference = searchScenes(db, query, fingerprint, LIMIT)
  const current = measure(() => searchScenes(db, query, fingerprint, LIMIT))
  const a = measure(() => variantA(db, query, fingerprint, LIMIT))
  const b = measure(() => variantB(db, query, fingerprint, LIMIT))
  console.info = info

  const hitsA = variantA(db, query, fingerprint, LIMIT)
  const hitsB = variantB(db, query, fingerprint, LIMIT)
  const equal = (left: SceneSearchHit[], right: SceneSearchHit[]) =>
    JSON.stringify(left) === JSON.stringify(right)

  console.log('\nimpl                  p50 ms   p95 ms   equal-to-current')
  const line = (label: string, t: { p50: number; p95: number }, same: string) =>
    console.log(`${label.padEnd(20)} ${t.p50.toFixed(2).padStart(7)} ${t.p95.toFixed(2).padStart(8)}   ${same}`)
  line('current', current, 'ref')
  line('variant A', a, String(equal(hitsA, reference)))
  line('variant B', b, String(equal(hitsB, reference)))
  console.log(`\ntop hit: ${JSON.stringify(reference[0])}`)
  console.log(`rss=${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`)
} finally {
  console.info = info
}
void getScene
