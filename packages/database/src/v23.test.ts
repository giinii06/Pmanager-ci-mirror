import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from './db'
import { MIGRATIONS, SCHEMA_VERSION } from './schema'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('schema v23 collections', () => {
  test('a v22 database gains the four collection tables and keeps its assets', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mv-v23-'))
    dirs.push(dir)
    const file = path.join(dir, 'legacy.db')

    const legacy = new Database(file)
    for (let index = 0; index < 22; index += 1) {
      MIGRATIONS[index]!((sql) => legacy.exec(sql))
    }
    legacy.exec('PRAGMA user_version = 22')
    legacy.exec("INSERT INTO libraries (id, name, root_path, created_at) VALUES ('lib1', 'Lib', 'Lib', 1)")
    legacy.exec("INSERT INTO users (id, username, password_hash, created_at) VALUES ('u1', 'owner', 'h', 1)")
    legacy.exec(`INSERT INTO assets (
      id, library_id, folder_id, relative_path, filename, kind, mime_type, size_bytes,
      mtime_ms, width, height, duration_ms, taken_at, file_version, indexed_at
    ) VALUES ('a1', 'lib1', NULL, 'a.mp4', 'a.mp4', 'video', 'video/mp4', 100, 1000, NULL, NULL, NULL, 1, 1, 1)`)
    legacy.close()

    const db = openDatabase(file)

    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(
      SCHEMA_VERSION,
    )
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(23)
    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'smart_albums','playlists','playlist_items','video_bookmarks'
         )
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name)
    expect(tables).toEqual(['playlist_items', 'playlists', 'smart_albums', 'video_bookmarks'])
    const indexes = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name IN (
           'ux_smart_albums_user_name','idx_smart_albums_user','ux_playlists_user_name',
           'ux_playlists_watch_later','idx_playlist_items_playlist','idx_video_bookmarks_user_asset'
         )
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name)
    expect(indexes).toEqual([
      'idx_playlist_items_playlist',
      'idx_smart_albums_user',
      'idx_video_bookmarks_user_asset',
      'ux_playlists_user_name',
      'ux_playlists_watch_later',
      'ux_smart_albums_user_name',
    ])
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM assets').get()!.n).toBe(1)
    db.close()
  })

  test('a playlist is unique per user by name, and one watch-later list exists per user', () => {
    const db = openDatabase(':memory:')
    db.exec("INSERT INTO users (id, username, password_hash, created_at) VALUES ('u1', 'a', 'h', 1), ('u2', 'b', 'h', 1)")
    const insert = (id: string, userId: string, name: string, kind = 'custom') =>
      db
        .query<null, [string, string, string, string]>(
          `INSERT INTO playlists (id, user_id, name, kind, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, 1)`,
        )
        .run(id, userId, name, kind)

    insert('p1', 'u1', 'Watch Later', 'watch_later')
    insert('p2', 'u2', 'Watch Later', 'watch_later')
    insert('p3', 'u1', 'Trips')

    expect(() => insert('p4', 'u1', 'trips')).toThrow()
    expect(() => insert('p5', 'u1', 'later', 'watch_later')).toThrow()
    db.close()
  })
})
