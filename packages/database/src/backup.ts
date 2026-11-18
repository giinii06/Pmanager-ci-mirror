import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { copyFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { newId } from '@mediavault/shared'
import type { Db } from './db'
import type { BackupLogRecord } from './types'

type Params = SQLQueryBindings[]

export interface BackupVerificationSummary {
  integrity: string
  assets: number
  folders: number
  tags: number
  voteEvents: number
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function verifyDatabaseBackup(backupPath: string): BackupVerificationSummary {
  const probe = new Database(backupPath, { readonly: true })
  try {
    const check = probe.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()
    const counts = probe
      .query<{ assets: number; folders: number; tags: number; voteEvents: number }, []>(
        `SELECT
           (SELECT COUNT(*) FROM assets WHERE deleted_at IS NULL) AS assets,
           (SELECT COUNT(*) FROM folders) AS folders,
           (SELECT COUNT(*) FROM tags) AS tags,
           (SELECT COUNT(*) FROM vote_events) AS voteEvents`,
      )
      .get()
    return {
      integrity: check?.integrity_check ?? 'failed',
      assets: counts?.assets ?? 0,
      folders: counts?.folders ?? 0,
      tags: counts?.tags ?? 0,
      voteEvents: counts?.voteEvents ?? 0,
    }
  } finally {
    probe.close()
  }
}

export function createDatabaseBackup(
  db: Db,
  backupDir: string,
  options: { retentionCount?: number; now?: number; prefix?: string } = {},
): BackupLogRecord {
  const now = options.now ?? Date.now()
  const retentionCount = Math.max(1, options.retentionCount ?? 14)
  const prefix = options.prefix ?? 'mediavault'
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const id = newId()
  const filename = `${prefix}-${stamp}-${id.slice(0, 6)}.db`
  const outPath = path.join(backupDir, filename)

  mkdirSync(backupDir, { recursive: true })
  try {
    db.exec(`VACUUM INTO ${sqlStringLiteral(outPath)}`)
    const summary = verifyDatabaseBackup(outPath)
    if (summary.integrity !== 'ok') {
      throw new Error(`backup integrity failed: ${summary.integrity}`)
    }
    const sizeBytes = statSync(outPath).size
    db.query<null, Params>(
      `INSERT INTO backup_logs (id, filename, size_bytes, integrity, created_at, error)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(id, filename, sizeBytes, summary.integrity, now)

    const existing = readdirSync(backupDir)
      .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.db'))
      .map((name) => ({ name, mtimeMs: statSync(path.join(backupDir, name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))

    for (const stale of existing.slice(retentionCount)) {
      try {
        rmSync(path.join(backupDir, stale.name), { force: true })
      } catch {}
    }

    return {
      id,
      filename,
      sizeBytes,
      integrity: summary.integrity,
      createdAt: now,
      error: null,
    }
  } catch (error) {
    rmSync(outPath, { force: true })
    const message = error instanceof Error ? error.message : String(error)
    db.query<null, Params>(
      `INSERT INTO backup_logs (id, filename, size_bytes, integrity, created_at, error)
       VALUES (?, ?, 0, 'failed', ?, ?)`,
    ).run(id, filename, now, message)
    throw error
  }
}

export function restoreDatabaseBackup(backupPath: string, destPath: string): BackupVerificationSummary {
  const verified = verifyDatabaseBackup(backupPath)
  if (verified.integrity !== 'ok') {
    throw new Error(`refusing to restore corrupt backup: ${verified.integrity}`)
  }
  const destDir = path.dirname(destPath)
  mkdirSync(destDir, { recursive: true })
  const tempPath = path.join(destDir, `.${path.basename(destPath)}.restore-${process.pid}-${Date.now()}`)
  try {
    copyFileSync(backupPath, tempPath)
    for (const suffix of ['-wal', '-shm']) {
      rmSync(`${destPath}${suffix}`, { force: true })
    }
    renameSync(tempPath, destPath)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
  return verifyDatabaseBackup(destPath)
}

export function listBackupLogs(db: Db, limit = 20): BackupLogRecord[] {
  return db
    .query<BackupLogRecord, Params>(
      `SELECT id, filename, size_bytes AS sizeBytes, integrity, created_at AS createdAt, error
       FROM backup_logs ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit)
}

export function getLatestBackupLog(db: Db, successfulOnly = false): BackupLogRecord | null {
  const where = successfulOnly ? "WHERE error IS NULL AND integrity = 'ok'" : ''
  return (
    db
      .query<BackupLogRecord, []>(
        `SELECT id, filename, size_bytes AS sizeBytes, integrity, created_at AS createdAt, error
         FROM backup_logs ${where} ORDER BY created_at DESC LIMIT 1`,
      )
      .get() ?? null
  )
}
