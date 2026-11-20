import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  claimNextJob,
  createLibrary,
  enqueueJob,
  enqueueNotificationDelivery,
  listWorkerHeartbeats,
  markLibraryFailure,
  openDatabase,
  recordWorkerHeartbeat,
  upsertNotification,
  type Db,
} from '@mediavault/database'
import { StructuredLogger } from '@mediavault/media'
import { PRIORITY } from '@mediavault/shared'
import type { WorkerConfig } from './config'
import { createDiskPolicy } from './disk-policy'
import { collectAlertFindings } from './observability/checks'
import { deliverDueNotifications } from './observability/discord'
import { runAlertEvaluation } from './observability/evaluator'
import { startWorkerHeartbeat } from './observability/heartbeat'

const dirs: string[] = []
const logger = new StructuredLogger('worker-test')

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

interface Harness {
  db: Db
  config: WorkerConfig
  dir: string
}

async function createHarness(overrides: Partial<WorkerConfig> = {}): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-worker-observability-'))
  dirs.push(dir)
  const config: WorkerConfig = {
    dataDir: dir,
    cacheDir: path.join(dir, 'cache'),
    mediaRoot: path.join(dir, 'media'),
    hwaccel: null,
    pollMs: 10,
    once: true,
    gpuResource: 'gpu:0',
    workerId: 'worker-test',
    scanDeleteGuardRatio: 0.2,
    scanDeleteForce: false,
    asrResultDir: path.join(dir, 'asr-results'),
    translationResultDir: path.join(dir, 'asr-results'),
    notificationsEnabled: true,
    alertIntervalMs: 50,
    minFreeBytes: 0,
    minFreeRatio: 0,
    ...overrides,
  }
  await mkdir(config.cacheDir, { recursive: true })
  await mkdir(config.mediaRoot, { recursive: true })
  const db = openDatabase(path.join(dir, 'mediavault.db'))
  return { db, config, dir }
}

function quietBackup(db: Db, now = Date.now()): void {
  db.query<null, [number]>(
    `INSERT INTO backup_logs (id, filename, size_bytes, integrity, created_at, error)
     VALUES ('b1', 'backup.db', 1024, 'ok', ?, NULL)`,
  ).run(now)
}

describe('alert checks', () => {
  test('an unreachable library root, low disk, missing backup and a restart loop are reported', async () => {
    const h = await createHarness({ minFreeBytes: Number.MAX_SAFE_INTEGER })
    createLibrary(h.db, { id: 'lib1', name: 'Lib', rootPath: 'Lib', createdAt: 1 })
    markLibraryFailure(h.db, {
      libraryId: 'lib1',
      state: 'OFFLINE',
      errorCode: 'drive_unavailable',
      now: Date.now(),
    })
    for (let index = 0; index < 5; index += 1) {
      recordWorkerHeartbeat(h.db, {
        instanceId: `boot-${index}`,
        workerId: 'worker-test',
        component: 'worker',
        pid: 1,
        state: 'idle',
        now: Date.now(),
      })
    }
    for (let index = 0; index < 3; index += 1) {
      enqueueJob(
        h.db,
        {
          dedupeKey: `gpu-${index}`,
          kind: 'hls',
          priority: PRIORITY.next,
          assetId: null,
        },
        Date.now(),
      )
    }
    h.db.query<null, [number]>(
      `UPDATE jobs SET state = 'failed', last_error = '[GPU_OOM] out of memory', completed_at = ?`,
    ).run(Date.now())

    const findings = await collectAlertFindings(h.db, h.config, Date.now())
    const kinds = findings.map((finding) => finding.kind)
    expect(kinds).toContain('drive_offline')
    expect(kinds).toContain('disk_low')
    expect(kinds).toContain('backup_missing')
    expect(kinds).toContain('restart_loop')
    expect(kinds).toContain('gpu_oom')
    expect(kinds).not.toContain('db_integrity')
  })

  test('a scan guard refusal is a mass-missing warning, not an offline drive', async () => {
    const h = await createHarness()
    createLibrary(h.db, { id: 'lib1', name: 'Lib', rootPath: 'Lib', createdAt: 1 })
    await mkdir(path.join(h.config.mediaRoot, 'Lib'), { recursive: true })
    quietBackup(h.db)
    markLibraryFailure(h.db, {
      libraryId: 'lib1',
      state: 'DEGRADED',
      errorCode: 'delete_guard',
      now: Date.now(),
    })

    const findings = await collectAlertFindings(h.db, h.config, Date.now())
    expect(findings.map((finding) => finding.kind)).toEqual(['mass_missing'])
  })

  test('a healthy library with a fresh backup is quiet', async () => {
    const h = await createHarness()
    createLibrary(h.db, { id: 'lib1', name: 'Lib', rootPath: 'Lib', createdAt: 1 })
    await mkdir(path.join(h.config.mediaRoot, 'Lib'), { recursive: true })
    quietBackup(h.db)

    const findings = await collectAlertFindings(h.db, h.config, Date.now())
    expect(findings).toEqual([])
  })
})

describe('alert evaluation', () => {
  test('one incident keeps one row across passes and resolves when the condition clears', async () => {
    const h = await createHarness()
    createLibrary(h.db, { id: 'lib1', name: 'Lib', rootPath: 'Lib', createdAt: 1 })
    quietBackup(h.db)
    const now = Date.now()

    const first = await runAlertEvaluation(h.db, h.config, logger, now)
    expect(first.opened).toBe(1)
    const second = await runAlertEvaluation(h.db, h.config, logger, now + 30_000)
    expect(second.opened).toBe(0)

    const rows = h.db
      .query<{ occurrences: number; state: string }, []>(
        'SELECT occurrences, state FROM notifications',
      )
      .all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.occurrences).toBe(2)
    expect(rows[0]!.state).toBe('open')

    await mkdir(path.join(h.config.mediaRoot, 'Lib'), { recursive: true })
    const recovered = await runAlertEvaluation(h.db, h.config, logger, now + 60_000)
    expect(recovered.resolved).toBe(1)
    expect(
      h.db.query<{ state: string }, []>('SELECT state FROM notifications').get()?.state,
    ).toBe('resolved')

    const later = await runAlertEvaluation(h.db, h.config, logger, now + 90_000)
    expect(later.opened).toBe(0)
  })
})

describe('discord delivery', () => {
  test('a failed attempt stays pending and the retry sends the alert', async () => {
    const h = await createHarness({ discordWebhookUrl: 'https://discord.invalid/webhook' })
    const now = Date.now()
    const { notification } = upsertNotification(
      h.db,
      {
        kind: 'drive_offline',
        severity: 'critical',
        dedupeKey: 'library:lib1:offline',
        title: '원본 저장소 연결 끊김: Lib',
        body: '경로에 접근할 수 없습니다.',
      },
      now,
      60_000,
    )
    enqueueNotificationDelivery(h.db, notification.id, 'alert', now)

    const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    const first = await deliverDueNotifications(h.db, h.config, logger, now, failing)
    expect(first.failed).toBe(1)

    const pending = h.db
      .query<{ status: string; attempts: number }, []>(
        'SELECT status, attempts FROM notification_delivery_attempts',
      )
      .get()
    expect(pending).toEqual({ status: 'pending', attempts: 1 })

    let body = ''
    const succeeding = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body ?? '')
      return new Response('ok', { status: 204 })
    }) as unknown as typeof fetch
    const second = await deliverDueNotifications(
      h.db,
      h.config,
      logger,
      now + 61_000,
      succeeding,
    )
    expect(second.sent).toBe(1)
    expect(body).toContain('원본 저장소 연결 끊김: Lib')
    expect(
      h.db.query<{ status: string }, []>('SELECT status FROM notification_delivery_attempts').get()
        ?.status,
    ).toBe('sent')
  })
})

describe('disk policy', () => {
  test('a full cache volume keeps cache-writing jobs queued', async () => {
    const h = await createHarness({ minFreeBytes: Number.MAX_SAFE_INTEGER })
    enqueueJob(
      h.db,
      { dedupeKey: 'thumb:a1:1', kind: 'thumbnail', priority: PRIORITY.next, assetId: null },
      Date.now(),
    )

    const policy = createDiskPolicy(h.config)
    const excluded = await policy.excludedKinds(Date.now())
    expect(excluded).toContain('thumbnail')
    expect(excluded).toContain('preview')
    expect(excluded).toContain('hls')

    const blocked = claimNextJob(h.db, Date.now(), {
      workerId: 'worker-test',
      excludeKinds: excluded,
    })
    expect(blocked).toBeNull()

    const claimed = claimNextJob(h.db, Date.now(), { workerId: 'worker-test' })
    expect(claimed?.kind).toBe('thumbnail')
  })
})

describe('heartbeats', () => {
  test('a boot is one row and the state follows the job', async () => {
    const h = await createHarness()
    const heartbeat = startWorkerHeartbeat(h.db, h.config)

    const initial = listWorkerHeartbeats(h.db)
    expect(initial).toHaveLength(1)
    expect(initial[0]!.state).toBe('idle')
    expect(initial[0]!.instanceId).not.toBe(h.config.workerId)

    heartbeat.setState('running', 7)
    const running = listWorkerHeartbeats(h.db)
    expect(running).toHaveLength(1)
    expect(running[0]!.state).toBe('running')
    expect(running[0]!.currentJobId).toBe(7)

    heartbeat.stop()
    expect(listWorkerHeartbeats(h.db)[0]!.state).toBe('stopping')
  })
})
