import { describe, expect, test } from 'bun:test'
import {
  createLibrary,
  enqueueArchiveJobIfNeeded,
  getArchiveJob,
  listArchiveJobs,
  openDatabase,
  updateArchiveJob,
} from './index'

function setup() {
  const db = openDatabase(':memory:')
  createLibrary(db, { id: 'lib', name: 'Media', rootPath: '/media', createdAt: 1 })
  return db
}

describe('archive history retention', () => {
  test('six terminal jobs retain the newest five and physically prune the oldest row', () => {
    const db = setup()
    try {
      for (let i = 0; i < 6; i += 1) {
        enqueueArchiveJobIfNeeded(db, {
          id: 'archive-' + i,
          libraryId: 'lib',
          archivePath: 'set-' + i + '.rar',
          signature: 'sig-' + i,
        }, i * 10 + 1)
        updateArchiveJob(db, 'archive-' + i, { state: 'completed' }, i * 10 + 2)
      }
      expect(listArchiveJobs(db).map((record) => record.id)).toEqual([
        'archive-5', 'archive-4', 'archive-3', 'archive-2', 'archive-1',
      ])
      expect(getArchiveJob(db, 'archive-0')).toBeNull()
    } finally {
      db.close()
    }
  })

  test('pruning preserves queued and converting jobs for the worker to finish', () => {
    const db = setup()
    try {
      const active = enqueueArchiveJobIfNeeded(db, {
        id: 'active', libraryId: 'lib', archivePath: 'active.rar', signature: 'active',
      }, 1).record
      updateArchiveJob(db, active.id, { state: 'converting' }, 2)
      for (let i = 0; i < 6; i += 1) {
        const id = 'done-' + i
        enqueueArchiveJobIfNeeded(db, {
          id, libraryId: 'lib', archivePath: id + '.rar', signature: id,
        }, 10 + i * 10)
        updateArchiveJob(db, id, { state: 'failed_password' }, 11 + i * 10)
      }
      expect(getArchiveJob(db, 'active')?.state).toBe('converting')
      expect(listArchiveJobs(db)).toHaveLength(5)
      expect(updateArchiveJob(db, 'active', { state: 'completed' }, 100)?.state).toBe('completed')
      expect(getArchiveJob(db, 'done-0')).toBeNull()
    } finally {
      db.close()
    }
  })
})
