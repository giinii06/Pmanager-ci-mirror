import type { SQLQueryBindings } from 'bun:sqlite'
import { newId } from '@mediavault/shared'
import type { Db } from './db'

type Params = SQLQueryBindings[]

export const JOURNAL_TITLE_MAX = 160
export const JOURNAL_BODY_MAX = 100_000

export interface JournalEntryRecord {
  id: string
  userId: string
  title: string
  body: string
  createdAt: number
  updatedAt: number
}

export type JournalEntrySummary = Omit<JournalEntryRecord, 'body'>

export interface JournalMentionRecord {
  type: 'video' | 'album'
  id: string
  label: string
  libraryName: string
}

const SELECT = 'id, user_id AS userId, title, body, created_at AS createdAt, updated_at AS updatedAt'

/** Creation time comes only from the API clock and never changes on an edit. */
export function createJournalEntry(db: Db, userId: string, now: number): JournalEntryRecord {
  const id = newId()
  db.query<null, Params>(
    'INSERT INTO journal_entries (id, user_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, userId, '', '', now, now)
  return getJournalEntry(db, userId, id)!
}

export function listJournalEntries(db: Db, userId: string): JournalEntrySummary[] {
  return db
    .query<JournalEntrySummary, [string]>(
      'SELECT id, user_id AS userId, title, created_at AS createdAt, updated_at AS updatedAt FROM journal_entries WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 500',
    )
    .all(userId)
}

export function getJournalEntry(db: Db, userId: string, id: string): JournalEntryRecord | null {
  return (
    db.query<JournalEntryRecord, [string, string]>(
      \`SELECT \${SELECT} FROM journal_entries WHERE user_id = ? AND id = ?\`,
    ).get(userId, id) ?? null
  )
}

export function updateJournalEntry(
  db: Db,
  userId: string,
  id: string,
  input: { title?: string; body?: string },
  now: number,
): JournalEntryRecord | null {
  const sets: string[] = []
  const values: Params = []
  if (input.title !== undefined) {
    if (input.title.length > JOURNAL_TITLE_MAX) throw new Error('Journal title too long')
    sets.push('title = ?')
    values.push(input.title)
  }
  if (input.body !== undefined) {
    if (input.body.length > JOURNAL_BODY_MAX) throw new Error('Journal body too long')
    sets.push('body = ?')
    values.push(input.body)
  }
  if (sets.length === 0) return getJournalEntry(db, userId, id)
  db.query<null, Params>(
    \`UPDATE journal_entries SET \${sets.join(', ')}, updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND user_id = ?\`,
  ).run(...values, now, id, userId)
  return getJournalEntry(db, userId, id)
}

export function deleteJournalEntry(db: Db, userId: string, id: string): boolean {
  return db
    .query<{ id: string }, [string, string]>(
      'DELETE FROM journal_entries WHERE id = ? AND user_id = ? RETURNING id',
    )
    .get(id, userId) !== null
}

/** Only live videos and image-containing folders can be mentioned. */
export function searchJournalMentions(db: Db, rawQuery: string): JournalMentionRecord[] {
  const safe = rawQuery.trim().slice(0, 80).replace(/[\\%_]/g, '\\$&')
  const pattern = \`%\${safe}%\`
  const videos = db
    .query<JournalMentionRecord, [string]>(
      \`SELECT 'video' AS type, a.id, a.filename AS label, l.name AS libraryName
       FROM assets a JOIN libraries l ON l.id = a.library_id
       WHERE a.kind = 'video' AND a.deleted_at IS NULL
         AND a.filename LIKE ? ESCAPE '\\'
       ORDER BY a.taken_at DESC, a.id DESC LIMIT 10\`,
    )
    .all(pattern)
  const albums = db
    .query<JournalMentionRecord, [string]>(
      \`SELECT 'album' AS type, f.id, f.name AS label, l.name AS libraryName
       FROM folders f JOIN libraries l ON l.id = f.library_id
       WHERE f.name LIKE ? ESCAPE '\\'
         AND EXISTS (
           SELECT 1 FROM assets a
           WHERE a.folder_id = f.id AND a.kind = 'image' AND a.deleted_at IS NULL
         )
       ORDER BY f.created_at DESC, f.id DESC LIMIT 10\`,
    )
    .all(pattern)
  return [...videos, ...albums].slice(0, 16)
}
