/**
 * Mints a session cookie for an automated browser or API check. Run it inside
 * the API container, where the database and secret live:
 *
 *   docker exec mediavault-api-1 bun scripts/mint-session.ts
 *
 * It prints `mv_session=<token>`; pass that as the Cookie header. The token is
 * random, only its keyed digest is stored, and the row expires in 30 days.
 */
import { Database } from 'bun:sqlite'
import { createHmac, randomBytes } from 'node:crypto'
import path from 'node:path'

const dataDir = process.env.DATA_DIR ?? '/data'
const db = new Database(path.join(dataDir, 'mediavault.db'))
db.exec('PRAGMA busy_timeout = 10000')
const secret = (await Bun.file(path.join(dataDir, 'secret.key')).text()).trim()

const user = db.query<{ id: string }, []>('SELECT id FROM users ORDER BY rowid LIMIT 1').get()
if (!user) throw new Error('no user exists yet; finish setup first')

const token = randomBytes(32).toString('base64url')
const digest = createHmac('sha256', secret).update(token).digest('hex')
const now = Date.now()
db.query(
  `INSERT INTO user_sessions (id, user_id, token_digest, user_agent, created_at, last_seen_at, expires_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
).run(`session${now.toString(36)}`, user.id, digest, 'agent', now, now, now + 30 * 86_400_000)
db.close()

console.log(`mv_session=${token}`)
