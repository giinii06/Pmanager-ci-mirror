import { Database } from 'bun:sqlite'
import { MIGRATIONS, SCHEMA_VERSION } from './schema'

export type Db = Database

export function openDatabase(filename: string): Db {
  const db = new Database(filename, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db)
  return db
}

export function getSqliteRuntimeInfo(db: Db): {
  sqliteVersion: string
  synchronousMode: string
  integrity: string
} {
  const versionRow = db.query<{ v: string }, []>('SELECT sqlite_version() AS v').get()
  const syncRow = db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()
  const syncNum = syncRow?.synchronous ?? -1
  const syncMap: Record<number, string> = { 0: 'OFF', 1: 'NORMAL', 2: 'FULL', 3: 'EXTRA' }
  const checkRow = db.query<{ quick_check: string }, []>('PRAGMA quick_check(1)').get()
  return {
    sqliteVersion: versionRow?.v ?? 'unknown',
    synchronousMode: syncMap[syncNum] ?? String(syncNum),
    integrity: checkRow?.quick_check ?? 'unknown',
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
