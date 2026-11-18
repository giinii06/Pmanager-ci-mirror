import { Database } from 'bun:sqlite'
import { MIGRATIONS, SCHEMA_VERSION } from './schema'

export type Db = Database

function runBusyRetry<T>(fn: () => T): T {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return fn()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('SQLITE_BUSY') || msg.includes('database is locked')) {
        Bun.sleepSync(50 * (attempt + 1))
        continue
      }
      throw error
    }
  }
  return fn()
}

export function openDatabase(filename: string): Db {
  const db = new Database(filename, { create: true })
  db.exec('PRAGMA busy_timeout = 10000')
  runBusyRetry(() => {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = FULL')
    db.exec('PRAGMA foreign_keys = ON')
    migrate(db)
  })
  return db
}

export function getSqliteRuntimeInfo(
  db: Db,
  options: { checkIntegrity?: boolean } = {},
): {
  sqliteVersion: string
  synchronousMode: string
  integrity: string
} {
  const versionRow = db.query<{ v: string }, []>('SELECT sqlite_version() AS v').get()
  const syncRow = db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()
  const syncNum = syncRow?.synchronous ?? -1
  const syncMap: Record<number, string> = { 0: 'OFF', 1: 'NORMAL', 2: 'FULL', 3: 'EXTRA' }
  const integrity = options.checkIntegrity === false
    ? 'skipped'
    : (db.query<{ quick_check: string }, []>('PRAGMA quick_check(1)').get()?.quick_check ?? 'unknown')
  return {
    sqliteVersion: versionRow?.v ?? 'unknown',
    synchronousMode: syncMap[syncNum] ?? String(syncNum),
    integrity,
  }
}

function migrate(db: Db): void {
  const readVersion = () =>
    db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0
  if (readVersion() >= SCHEMA_VERSION) return

  db.transaction(() => {
    const version = readVersion()
    if (version >= SCHEMA_VERSION) return
    for (let index = version; index < SCHEMA_VERSION; index += 1) {
      const migration = MIGRATIONS[index]
      if (!migration) throw new Error(`missing migration ${index + 1}`)
      migration((sql) => db.exec(sql))
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }).immediate()
}
