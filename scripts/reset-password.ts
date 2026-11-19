/**
 * Offline password recovery. This is the only way back in if the operator
 * forgets the password, because no recovery endpoint exists by design.
 *
 *   printf '%s\n' 'new password' | \
 *     docker exec -i mediavault-api-1 bun scripts/reset-password.ts --user xo
 *
 * Stop the API first. Never copy a WAL-mode database file while the API is
 * writing to it; run this against the live `/data` volume in place.
 */
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { revokeAllSessions, recordAuthEvent } from '@mediavault/database'
import { hashPassword } from '../apps/api/src/auth'

interface Options {
  dbPath: string
  username: string
  password: string
}

function parseArgs(argv: string[]): { dbPath?: string; username?: string } {
  const options: { dbPath?: string; username?: string } = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--db') options.dbPath = argv[++index]
    else if (arg === '--user') options.username = argv[++index]
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

async function readPassword(): Promise<string> {
  const piped = !process.stdin.isTTY
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !piped })
  try {
    if (piped) {
      const line = await rl.question('')
      return line.trim()
    }
    const first = (await rl.question('New password: ')).trim()
    const second = (await rl.question('Repeat password: ')).trim()
    if (first !== second) throw new Error('the passwords do not match')
    return first
  } finally {
    rl.close()
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = path.resolve(
    args.dbPath ?? process.env.DATABASE_PATH ?? path.join(process.env.DATA_DIR ?? 'data', 'mediavault.db'),
  )
  if (!existsSync(dbPath)) {
    throw new Error(`database not found at ${dbPath}; pass --db or set DATA_DIR`)
  }

  const db = new Database(dbPath)
  db.exec('PRAGMA busy_timeout = 10000')
  db.exec('PRAGMA foreign_keys = ON')
  try {
    const users = db.query<{ id: string; username: string }, []>('SELECT id, username FROM users').all()
    if (users.length === 0) throw new Error('this database has no users yet; use the setup page')

    let user = users[0]!
    if (args.username) {
      const match = users.find((row) => row.username.toLowerCase() === args.username!.toLowerCase())
      if (!match) throw new Error(`no user named ${args.username}; found: ${users.map((row) => row.username).join(', ')}`)
      user = match
    } else if (users.length > 1) {
      throw new Error(`pass --user, this database has: ${users.map((row) => row.username).join(', ')}`)
    }

    const password = await readPassword()
    if (password.length < 8) throw new Error('use at least 8 characters')

    const passwordHash = await hashPassword(password)
    const now = Date.now()
    db.transaction(() => {
      db.query('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id)
      revokeAllSessions(db, user.id, now)
      recordAuthEvent(db, {
        kind: 'password_reset',
        userId: user.id,
        username: user.username,
        detail: 'offline script',
        createdAt: now,
      })
    }).immediate()

    console.log(`password reset for ${user.username}; every session was revoked`)
  } finally {
    db.close()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
