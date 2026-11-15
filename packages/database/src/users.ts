import type { SQLQueryBindings } from 'bun:sqlite'
import type { Db } from './db'
import type { UserRecord } from './types'

type Params = SQLQueryBindings[]

export function countUsers(db: Db): number {
  return db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM users').get()?.n ?? 0
}

export function createUser(db: Db, user: UserRecord): void {
  db.query<null, Params>(
    'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
  ).run(user.id, user.username, user.passwordHash, user.createdAt)
}

export function findUserByUsername(db: Db, username: string): UserRecord | null {
  return (
    db
      .query<UserRecord, Params>(
        'SELECT id, username, password_hash AS passwordHash, created_at AS createdAt FROM users WHERE username = ? COLLATE NOCASE',
      )
      .get(username) ?? null
  )
}

export function findUserById(db: Db, id: string): UserRecord | null {
  return (
    db
      .query<UserRecord, Params>(
        'SELECT id, username, password_hash AS passwordHash, created_at AS createdAt FROM users WHERE id = ?',
      )
      .get(id) ?? null
  )
}
