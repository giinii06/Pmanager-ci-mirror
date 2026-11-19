import {
  getAssetNeighbor,
  listAssets,
  openDatabase,
  pickRandomAsset,
  type AssetFilter,
} from '../packages/database/src/index'

const target = process.argv[2]
if (!target) {
  console.error('usage: bun scripts/bench-navigation.ts <database>')
  process.exit(1)
}

const SORTS = ['latest', 'name', 'views', 'watch_time', 'votes', 'rate'] as const
const BASES: Array<{ label: string; filter: AssetFilter }> = [
  { label: 'videos', filter: { kind: 'video' } },
  { label: 'images', filter: { kind: 'image' } },
  { label: 'all', filter: {} },
]

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index] ?? 0
}

function summarize(label: string, samples: number[]): void {
  const p50 = percentile(samples, 0.5).toFixed(2)
  const p95 = percentile(samples, 0.95).toFixed(2)
  console.log(`${label.padEnd(34)} p50 ${p50.padStart(7)} ms   p95 ${p95.padStart(7)} ms`)
}

const db = openDatabase(target)
const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version
const total = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM assets WHERE deleted_at IS NULL').get()?.n
console.log(`db=${target} schema=v${version} activeAssets=${total}\n`)

for (const base of BASES) {
  for (const sort of SORTS) {
    const filter: AssetFilter = { ...base.filter, sort }
    if (sort === 'rate') filter.seed = 7
    const page = listAssets(db, filter, null, 50)
    if (page.records.length < 3) continue
    const anchors = page.records.map((record) => record.id)
    const samples: number[] = []
    for (let index = 0; index < 40; index += 1) {
      const anchor = anchors[index % anchors.length]!
      const direction = index % 2 === 0 ? 'next' : 'prev'
      const started = performance.now()
      getAssetNeighbor(db, anchor, filter, direction)
      samples.push(performance.now() - started)
    }
    summarize(`${base.label} / ${sort} (${page.total})`, samples)
  }
}

for (const base of BASES) {
  const samples: number[] = []
  for (let index = 0; index < 200; index += 1) {
    const started = performance.now()
    pickRandomAsset(db, base.filter)
    samples.push(performance.now() - started)
  }
  summarize(`random / ${base.label}`, samples)
}
