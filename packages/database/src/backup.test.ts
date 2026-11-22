import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from './db'
import { createDatabaseBackup, verifyDatabaseBackup } from './backup'

test('keeps exactly the latest five verified database snapshots', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mediavault-backup-five-'))
  const db = openDatabase(':memory:')
  try {
    const created: string[] = []
    for (let i = 0; i < 7; i += 1) {
      const record = createDatabaseBackup(db, dir, { now: Date.UTC(2026, 0, 1 + i) })
      expect(record.integrity).toBe('ok')
      created.push(record.filename)
    }
    const current = readdirSync(dir).filter((name) => name.endsWith('.db')).sort()
    expect(current).toEqual(created.slice(-5).sort())
    for (const file of current) expect(verifyDatabaseBackup(path.join(dir, file)).integrity).toBe('ok')
    // An overly large requested retention must still respect the five-file cap.
    createDatabaseBackup(db, dir, { now: Date.UTC(2026, 0, 8), retentionCount: 99 })
    expect(readdirSync(dir).filter((name) => name.endsWith('.db'))).toHaveLength(5)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
