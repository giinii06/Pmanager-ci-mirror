import { describe, expect, test } from 'bun:test'
import {
  countWorkerInstancesSince,
  listWorkerHeartbeats,
  openDatabase,
  pruneWorkerHeartbeats,
  recordWorkerHeartbeat,
} from './index'

describe('worker heartbeats', () => {
  test('one row per boot, updated in place', () => {
    const db = openDatabase(':memory:')
    recordWorkerHeartbeat(db, {
      instanceId: 'boot-a',
      workerId: 'worker-1',
      component: 'media',
      pid: 42,
      state: 'idle',
      now: 1_000,
    })
    recordWorkerHeartbeat(db, {
      instanceId: 'boot-a',
      workerId: 'worker-1',
      component: 'media',
      pid: 42,
      state: 'running',
      currentJobId: 7,
      now: 21_000,
    })

    const rows = listWorkerHeartbeats(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      instanceId: 'boot-a',
      state: 'running',
      currentJobId: 7,
      startedAt: 1_000,
      lastSeenAt: 21_000,
    })
    db.close()
  })

  test('restart loop counting uses distinct boots, not the reused worker id', () => {
    const db = openDatabase(':memory:')
    for (let index = 0; index < 5; index += 1) {
      recordWorkerHeartbeat(db, {
        instanceId: `boot-${index}`,
        workerId: 'worker-1',
        component: 'media',
        pid: 42,
        state: 'idle',
        now: 10_000 + index,
      })
    }
    recordWorkerHeartbeat(db, {
      instanceId: 'boot-old',
      workerId: 'worker-1',
      component: 'media',
      pid: 42,
      state: 'idle',
      now: 1,
    })

    expect(countWorkerInstancesSince(db, 0)).toBe(6)
    expect(countWorkerInstancesSince(db, 10_000)).toBe(5)
    db.close()
  })

  test('prunes rows that stopped reporting', () => {
    const db = openDatabase(':memory:')
    recordWorkerHeartbeat(db, {
      instanceId: 'boot-a',
      workerId: 'worker-1',
      component: 'media',
      pid: 1,
      state: 'idle',
      now: 1_000,
    })
    recordWorkerHeartbeat(db, {
      instanceId: 'boot-b',
      workerId: 'worker-1',
      component: 'media',
      pid: 1,
      state: 'idle',
      now: 5_000,
    })

    expect(pruneWorkerHeartbeats(db, 2_000)).toBe(1)
    expect(listWorkerHeartbeats(db).map((row) => row.instanceId)).toEqual(['boot-b'])
    db.close()
  })
})
