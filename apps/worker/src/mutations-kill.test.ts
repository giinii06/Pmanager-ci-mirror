import { afterAll, describe, expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  claimNextMutation,
  createDeleteMutation,
  createLibrary,
  createUser,
  getFileMutation,
  getMutationAsset,
  insertAsset,
  listMutationEvents,
  markLibraryHealthy,
  openDatabase,
  releaseMutationLease,
  upsertFolder,
  type Db,
  type FileMutationRecord,
} from '@mediavault/database'
import type { WorkerConfig } from './config'
import { executeDeleteMutation, type MutationContext } from './mutations/delete'

const dirs: string[] = []
const fixture = path.join(import.meta.dir, 'mutations-kill.fixture.ts')
const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-mutations-kill-'))
  dirs.push(dir)
  const mediaRoot = path.join(dir, 'media')
  const cacheDir = path.join(dir, 'cache')
  const dataDir = path.join(dir, 'data')
  const libraryDir = path.join(mediaRoot, 'Lib')
  await mkdir(libraryDir, { recursive: true })
  await mkdir(cacheDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await mkdir(path.join(cacheDir, 'thumbs', 'a1', 'v1'), { recursive: true })
  await writeFile(path.join(cacheDir, 'thumbs', 'a1', 'v1', '320.webp'), 'thumb')

  const file = path.join(libraryDir, 'clip.mp4')
  await writeFile(file, Buffer.alloc(2048, 7))
  const info = await stat(file)

  const dbPath = path.join(dataDir, 'mediavault.db')
  const db: Db = openDatabase(dbPath)
  createUser(db, { id: 'u1', username: 'owner', passwordHash: 'x', createdAt: 1 })
  createLibrary(db, { id: 'lib1', name: 'Lib', rootPath: 'Lib', createdAt: 1 })
  markLibraryHealthy(db, { libraryId: 'lib1', rootIdentity: '1:2', now: 1 })
  const folderId = upsertFolder(db, {
    id: 'f1',
    libraryId: 'lib1',
    parentId: null,
    relativePath: '',
    name: 'Lib',
    depth: 0,
    scanId: 's1',
    createdAt: 1,
  })
  insertAsset(db, {
    id: 'a1',
    libraryId: 'lib1',
    folderId,
    relativePath: 'clip.mp4',
    filename: 'clip.mp4',
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: info.size,
    mtimeMs: Math.round(info.mtimeMs),
    width: 640,
    height: 360,
    durationMs: 1000,
    takenAt: 1,
    videoCodec: 'h264',
    audioCodec: null,
    container: 'mp4',
    indexedAt: 1,
    scanId: 's1',
  })

  const config: WorkerConfig = {
    dataDir,
    cacheDir,
    mediaRoot,
    hwaccel: null,
    pollMs: 0,
    once: true,
    gpuResource: 'gpu:0',
    workerId: 'recovery',
    scanDeleteGuardRatio: 0.2,
    scanDeleteForce: false,
    asrResultDir: path.join(dir, 'asr-results'),
    translationResultDir: path.join(dir, 'asr-results'),
  }

  const created = createDeleteMutation(db, {
    assetId: 'a1',
    libraryId: 'lib1',
    userId: 'u1',
    requestKey: 'u1:kill',
    requestedFileVersion: 1,
    sourceRel: 'clip.mp4',
    now: Date.now(),
  })

  return { dir, db, dbPath, config, file, mutation: created.record }
}

function quarantinePath(record: FileMutationRecord): string | null {
  if (!record.quarantineRoot || !record.quarantineRel) return null
  return path.join(record.quarantineRoot, record.quarantineRel)
}

async function killAt(stage: string, h: Awaited<ReturnType<typeof setup>>): Promise<void> {
  const proc = Bun.spawn([process.execPath, fixture], {
    env: {
      ...process.env,
      KILL_AT: stage,
      MUTATION_ID: h.mutation.id,
      DB_PATH: h.dbPath,
      MEDIA_ROOT: h.config.mediaRoot,
      CACHE_DIR: h.config.cacheDir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const code = await proc.exited
  if (proc.signalCode !== 'SIGKILL') {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`fixture exited with ${code}/${proc.signalCode}: ${stderr}`)
  }
}

/** Simulates lease expiry; the v17 suite already covers the fence itself. */
function expireLease(db: Db, mutationId: string): void {
  db.query(
    'UPDATE file_mutations SET lease_owner = NULL, lease_expires_at = NULL, retry_after = 0 WHERE id = ?',
  ).run(mutationId)
}

async function recover(db: Db, config: WorkerConfig, mutationId: string): Promise<FileMutationRecord> {
  const now = Date.now()
  const claimed = claimNextMutation(db, now, { workerId: 'recovery', leaseMs: 60_000 })
  expect(claimed?.id).toBe(mutationId)
  let record = claimed!
  for (let step = 0; step < 8; step += 1) {
    const ctx: MutationContext = {
      db,
      config,
      logger: silentLogger,
      fence: { workerId: 'recovery', leaseEpoch: record.leaseEpoch, now: Date.now() },
    }
    await executeDeleteMutation(ctx, record)
    record = getFileMutation(db, mutationId)!
    if (record.state === 'completed' || record.state === 'blocked') break
  }
  releaseMutationLease(db, mutationId, {
    workerId: 'recovery',
    leaseEpoch: record.leaseEpoch,
    now: Date.now(),
  })
  return getFileMutation(db, mutationId)!
}

describe('a killed delete worker resumes without guessing', () => {
  test('SIGKILL after validation keeps the tombstone and the source', async () => {
    const h = await setup()
    await killAt('validated', h)

    const record = getFileMutation(h.db, h.mutation.id)!
    expect(record.state).toBe('validated')
    expect(await exists(h.file)).toBe(true)
    expect(await exists(quarantinePath(record)!)).toBe(false)
    const asset = getMutationAsset(h.db, 'a1')
    expect(asset?.pendingDeleteMutationId).toBe(record.id)
    expect(asset?.deletedAt).not.toBeNull()

    expireLease(h.db, h.mutation.id)
    const done = await recover(h.db, h.config, h.mutation.id)
    expect(done.state).toBe('completed')
    expect(getMutationAsset(h.db, 'a1')).toBeNull()
    expect(await exists(h.file)).toBe(false)
    expect(await exists(quarantinePath(done)!)).toBe(false)
    h.db.close()
  })

  test('SIGKILL after the quarantine rename resumes from the quarantined file', async () => {
    const h = await setup()
    await killAt('quarantined', h)

    const record = getFileMutation(h.db, h.mutation.id)!
    expect(record.state).toBe('quarantined')
    expect(await exists(h.file)).toBe(false)
    expect(await exists(quarantinePath(record)!)).toBe(true)
    expect(getMutationAsset(h.db, 'a1')?.pendingDeleteMutationId).toBe(record.id)

    expireLease(h.db, h.mutation.id)
    const done = await recover(h.db, h.config, h.mutation.id)
    expect(done.state).toBe('completed')
    expect(getMutationAsset(h.db, 'a1')).toBeNull()
    expect(await exists(quarantinePath(done)!)).toBe(false)
    h.db.close()
  })

  test('SIGKILL after the DB commit still purges the quarantined file', async () => {
    const h = await setup()
    await killAt('db_committed', h)

    const record = getFileMutation(h.db, h.mutation.id)!
    expect(record.state).toBe('db_committed')
    expect(getMutationAsset(h.db, 'a1')).toBeNull()
    expect(await exists(quarantinePath(record)!)).toBe(true)

    expireLease(h.db, h.mutation.id)
    const done = await recover(h.db, h.config, h.mutation.id)
    expect(done.state).toBe('completed')
    expect(await exists(quarantinePath(done)!)).toBe(false)
    expect(await exists(h.file)).toBe(false)
    h.db.close()
  })

  test('SIGKILL after the final unlink completes without looking for the file', async () => {
    const h = await setup()
    await killAt('purging', h)

    const record = getFileMutation(h.db, h.mutation.id)!
    expect(record.state).toBe('purging')
    expect(getMutationAsset(h.db, 'a1')).toBeNull()
    expect(await exists(h.file)).toBe(false)
    expect(await exists(quarantinePath(record)!)).toBe(false)

    expireLease(h.db, h.mutation.id)
    const done = await recover(h.db, h.config, h.mutation.id)
    expect(done.state).toBe('completed')
    const events = listMutationEvents(h.db, h.mutation.id)
    expect(events.at(-1)?.state).toBe('completed')
    h.db.close()
  })
})
