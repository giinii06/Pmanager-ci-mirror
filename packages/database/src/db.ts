import { Database } from 'bun:sqlite'
import { MIGRATIONS, SCHEMA_VERSION } from './schema'

export type Db = Database

export function openDatabase(filename: string): Db {
  const db = new Database(filename, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db)
  return db
}

function migrate(db: Db): void {
  const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get()
  const version = row?.user_version ?? 0
  if (version >= SCHEMA_VERSION) return

  db.transaction(() => {
    for (let index = version; index < SCHEMA_VERSION; index += 1) {
      const migration = MIGRATIONS[index]
      if (!migration) throw new Error(`missing migration ${index + 1}`)
      migration((sql) => db.exec(sql))
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  })()
}
