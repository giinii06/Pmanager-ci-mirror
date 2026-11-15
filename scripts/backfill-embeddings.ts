/**
 * Queues one embedding pass for every video in the library.
 *
 *   bun run scripts/backfill-embeddings.ts --dry-run
 *   MV_USERNAME=... MV_PASSWORD=... bun run scripts/backfill-embeddings.ts
 *
 * The database is opened read-only. Only the API writes it, and the queue row is
 * the API's to create. A second run is safe: the enqueue upserts on the active
 * job for the asset and file version.
 *
 * A video with no transcript is queued too. The worker embeds the filename stem
 * alone, which still ranks it against the rest of the library, and skipping it
 * would leave that video invisible to /api/assets/:id/related forever.
 *
 * Credentials: MV_SESSION holds a session cookie, either the bare token or the
 * whole `mv_session=...` pair. Without it the script logs in with MV_USERNAME
 * and MV_PASSWORD. MV_BASE_URL defaults to http://127.0.0.1:8787 and DATA_DIR
 * to ./data.
 */
import { Database } from 'bun:sqlite'
import path from 'node:path'

const BASE = (process.env.MV_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
const DATA_DIR = process.env.DATA_DIR ?? path.resolve(import.meta.dir, '..', 'data')
const DB_PATH = path.join(DATA_DIR, 'mediavault.db')
const DRY_RUN = process.argv.includes('--dry-run')

interface VideoRow {
  id: string
  filename: string
  hasTranscript: number
}

function fail(message: string): never {
  console.error(`FAIL  ${message}`)
  process.exit(1)
}

function readVideos(): VideoRow[] {
  const db = new Database(DB_PATH, { readonly: true })
  try {
    return db
      .query<VideoRow, []>(
        `SELECT a.id AS id,
                a.filename AS filename,
                EXISTS (
                  SELECT 1 FROM transcripts t
                   WHERE t.asset_id = a.id AND t.file_version = a.file_version
                ) AS hasTranscript
           FROM assets a
          WHERE a.kind = 'video' AND a.deleted_at IS NULL
          ORDER BY a.filename`,
      )
      .all()
  } finally {
    db.close()
  }
}

let cookie = process.env.MV_SESSION?.trim() ?? ''

async function login(): Promise<void> {
  if (cookie) {
    if (!cookie.includes('=')) cookie = `mv_session=${cookie}`
    return
  }

  const username = process.env.MV_USERNAME
  const password = process.env.MV_PASSWORD
  if (!username || !password) {
    fail('Set MV_SESSION to a session cookie, or MV_USERNAME and MV_PASSWORD to log in.')
  }

  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!response.ok) fail(`login returned ${response.status}: ${await response.text()}`)

  cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  if (!cookie.startsWith('mv_session=')) fail('login did not set a session cookie')
}

async function enqueue(video: VideoRow): Promise<boolean> {
  const response = await fetch(`${BASE}/api/assets/${encodeURIComponent(video.id)}/embedding`, {
    method: 'POST',
    headers: { cookie },
  })
  if (response.status === 202) return true
  if (response.status === 409) return false
  if (response.status === 503) {
    fail('The API reports embeddings disabled. Set EMBEDDING_WORKER_TOKEN on it and restart.')
  }
  fail(`${video.filename}: ${response.status} ${await response.text()}`)
}

const videos = readVideos()
const withTranscript = videos.filter((video) => video.hasTranscript === 1)
const titleOnly = videos.length - withTranscript.length
console.log(
  `${videos.length} videos: ${withTranscript.length} with a transcript, ${titleOnly} title-only`,
)

if (DRY_RUN) {
  for (const video of videos) {
    console.log(`  would queue  ${video.filename}${video.hasTranscript ? '' : ' (title only)'}`)
  }
  process.exit(0)
}

if (videos.length === 0) {
  console.log('nothing to queue')
  process.exit(0)
}

await login()

const skipped: string[] = []
for (const video of videos) {
  if (!(await enqueue(video))) skipped.push(video.filename)
}

console.log(`queued ${videos.length - skipped.length}/${videos.length}`)
if (skipped.length > 0) {
  console.log(`skipped ${skipped.length}, the API refused them:`)
  for (const filename of skipped) console.log(`  ${filename}`)
  process.exitCode = 1
}
