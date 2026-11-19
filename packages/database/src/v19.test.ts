import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  countLoginAttempts,
  countLoginFailures,
  createUser,
  deleteStaleSessions,
  findSessionByDigest,
  finishLoginAttempt,
  insertLoginAttempt,
  insertSession,
  listSessions,
  oldestLoginFailure,
  openDatabase,
  pruneLoginAttempts,
  recordAuthEvent,
  revokeAllSessions,
  revokeSession,
  touchSession,
  type Db,
} from './index'
import { MIGRATIONS, SCHEMA_VERSION } from './schema'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function seedUser(db: Db, id = 'user1') {
  createUser(db, { id, username: `name-${id}`, passwordHash: 'hash', createdAt: 1 })
}

describe('schema v19 auth sessions', () => {
  test('migrates a v18 database and keeps users and assets', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mv-v19-'))
    dirs.push(dir)
    const file = path.join(dir, 'legacy.db')

    const legacy = new Database(file)
    legacy.exec('PRAGMA foreign_keys = ON')
    for (let index = 0; index < 18; index += 1) {
      MIGRATIONS[index]!((sql) => legacy.exec(sql))
    }
    legacy.exec('PRAGMA user_version = 18')
    legacy
      .query('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run('u1', 'owner', 'hash', 1)
    legacy.close()

    const db = openDatabase(file)
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(
      SCHEMA_VERSION,
    )
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM users').get()!.n).toBe(1)
    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name IN ('user_sessions','auth_login_attempts','auth_events') ORDER BY name`,
      )
      .all()
      .map((row) => row.name)
    expect(tables).toEqual(['auth_events', 'auth_login_attempts', 'user_sessions'])
    db.close()
  })

  test('a session row needs an existing user', () => {
    const db = openDatabase(':memory:')
    expect(() =>
      insertSession(db, {
        id: 's1',
        userId: 'missing',
        tokenDigest: 'd1',
        userAgent: null,
        createdAt: 1,
        expiresAt: 2,
      }),
    ).toThrow()
    db.close()
  })

  test('lookup ignores expired and revoked rows', () => {
    const db = openDatabase(':memory:')
    seedUser(db)
    insertSession(db, {
      id: 's1',
      userId: 'user1',
      tokenDigest: 'd1',
      userAgent: 'ua',
      createdAt: 1_000,
      expiresAt: 2_000,
    })

    expect(findSessionByDigest(db, 'd1', 1_500)?.id).toBe('s1')
    expect(findSessionByDigest(db, 'd1', 2_000)).toBeNull()
    expect(revokeSession(db, 's1', 1_600)).toBe(true)
    expect(findSessionByDigest(db, 'd1', 1_700)).toBeNull()
    expect(revokeSession(db, 's1', 1_800)).toBe(false)
    db.close()
  })

  test('revoking is scoped to its owner', () => {
    const db = openDatabase(':memory:')
    seedUser(db, 'user1')
    seedUser(db, 'user2')
    insertSession(db, {
      id: 's1',
      userId: 'user1',
      tokenDigest: 'd1',
      userAgent: null,
      createdAt: 1,
      expiresAt: 10_000,
    })
    expect(revokeSession(db, 's1', 2, 'user2')).toBe(false)
    expect(findSessionByDigest(db, 'd1', 3)?.id).toBe('s1')
    expect(revokeSession(db, 's1', 4, 'user1')).toBe(true)
    db.close()
  })

  test('touch advances at most once per interval', () => {
    const db = openDatabase(':memory:')
    seedUser(db)
    insertSession(db, {
      id: 's1',
      userId: 'user1',
      tokenDigest: 'd1',
      userAgent: null,
      createdAt: 1_000,
      expiresAt: 1_000_000,
    })
    expect(touchSession(db, 's1', 400_000, 300_000)).toBe(true)
    expect(touchSession(db, 's1', 400_100, 300_000)).toBe(false)
    expect(touchSession(db, 's1', 800_000, 300_000)).toBe(true)
    db.close()
  })

  test('logout-all leaves one session when asked to', () => {
    const db = openDatabase(':memory:')
    seedUser(db)
    for (const id of ['s1', 's2', 's3']) {
      insertSession(db, {
        id,
        userId: 'user1',
        tokenDigest: `d-${id}`,
        userAgent: null,
        createdAt: 1,
        expiresAt: 100_000,
      })
    }
    expect(revokeAllSessions(db, 'user1', 2, 's2')).toBe(2)
    expect(listSessions(db, 'user1', 3).map((row) => row.id)).toEqual(['s2'])
    expect(revokeAllSessions(db, 'user1', 4)).toBe(1)
    expect(listSessions(db, 'user1', 5)).toEqual([])
    db.close()
  })

  test('stale sessions are removed and active ones are kept', () => {
    const db = openDatabase(':memory:')
    seedUser(db)
    insertSession(db, {
      id: 'old',
      userId: 'user1',
      tokenDigest: 'd-old',
      userAgent: null,
      createdAt: 1,
      expiresAt: 100,
    })
    insertSession(db, {
      id: 'live',
      userId: 'user1',
      tokenDigest: 'd-live',
      userAgent: null,
      createdAt: 1,
      expiresAt: 1_000_000,
    })
    expect(deleteStaleSessions(db, 1_000)).toBe(1)
    expect(findSessionByDigest(db, 'd-live', 2_000)?.id).toBe('live')
    db.close()
  })

  test('login attempts count by ip and by username failure', () => {
    const db = openDatabase(':memory:')
    const first = insertLoginAttempt(db, { username: 'xo', ip: '1.2.3.4', createdAt: 1_000 })
    finishLoginAttempt(db, first, 'failure')
    const second = insertLoginAttempt(db, { username: 'xo', ip: '1.2.3.4', createdAt: 2_000 })
    finishLoginAttempt(db, second, 'success')
    insertLoginAttempt(db, { username: 'other', ip: '5.6.7.8', createdAt: 3_000 })

    expect(countLoginAttempts(db, '1.2.3.4', 0)).toBe(2)
    expect(countLoginFailures(db, 'xo', 0)).toBe(1)
    expect(oldestLoginFailure(db, 'xo', 0)).toBe(1_000)
    expect(countLoginFailures(db, 'xo', 1_500)).toBe(0)
    expect(pruneLoginAttempts(db, 2_500)).toBe(2)
    db.close()
  })

  test('auth events keep the kind and a bounded detail', () => {
    const db = openDatabase(':memory:')
    recordAuthEvent(db, {
      kind: 'login_failure',
      username: 'xo',
      ip: '1.2.3.4',
      detail: 'x'.repeat(900),
      createdAt: 1,
    })
    const row = db
      .query<{ kind: string; detail: string }, []>('SELECT kind, detail FROM auth_events')
      .get()!
    expect(row.kind).toBe('login_failure')
    expect(row.detail.length).toBe(500)
    db.close()
  })
})
