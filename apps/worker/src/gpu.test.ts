import { afterEach, describe, expect, test } from 'bun:test'
import { acquireGpuLease, getGpuLease, openDatabase, type Db } from '@mediavault/database'
import { withGpuLease } from './gpu'

const RESOURCE = 'gpu:0'

const dbs: Db[] = []

function open(): Db {
  const db = openDatabase(':memory:')
  dbs.push(db)
  return db
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

function options(waitMs = 0, leaseMs = 120_000) {
  return {
    resourceId: RESOURCE,
    owner: 'media-worker',
    taskKind: 'hls',
    waitMs,
    leaseMs,
  }
}

describe('withGpuLease', () => {
  test('a free card is held for the callback and released afterwards', async () => {
    const db = open()
    const held: boolean[] = []

    const result = await withGpuLease(db, options(), async (granted) => {
      held.push(granted)
      expect(getGpuLease(db, RESOURCE)?.owner).toBe('media-worker')
      return 'encoded'
    })

    expect(result).toBe('encoded')
    expect(held).toEqual([true])
    expect(getGpuLease(db, RESOURCE)).toBeNull()
  })

  test('a card another worker holds runs the callback without it', async () => {
    const db = open()
    acquireGpuLease(
      db,
      { resourceId: RESOURCE, owner: 'asr-worker', taskKind: 'asr', leaseMs: 120_000 },
      Date.now(),
    )
    const held: boolean[] = []

    await withGpuLease(db, options(), async (granted) => {
      held.push(granted)
    })

    expect(held).toEqual([false])
    expect(getGpuLease(db, RESOURCE)?.owner).toBe('asr-worker')
  })

  test('a throwing callback still releases the lease', async () => {
    const db = open()

    await expect(
      withGpuLease(db, options(), async () => {
        throw new Error('ffmpeg exited 1')
      }),
    ).rejects.toThrow('ffmpeg exited 1')

    expect(getGpuLease(db, RESOURCE)).toBeNull()
  })

  test('the heartbeat keeps the lease alive past its first expiry', async () => {
    const db = open()

    await withGpuLease(db, options(0, 120), async () => {
      await Bun.sleep(200)
      const lease = getGpuLease(db, RESOURCE)
      expect(lease?.owner).toBe('media-worker')
      expect(lease?.leaseExpiresAt).toBeGreaterThan(Date.now())
    })
  })
})
