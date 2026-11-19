import { afterAll, describe, expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
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
  markLibraryFailure,
  markLibraryHealthy,
  openDatabase,
  releaseMutationLease,
  touchAssets,
  updateAssetFile,
  upsertFolder,
  type Db,
  type FileMutationRecord,
} from '@mediavault/database'
import type { WorkerConfig } from './config'
import { executeDeleteMutation, type MutationContext } from './mutations/delete'

const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function setup(options: { content?: Buffer; symlinkSource?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-mutations-'))
  dirs.push(dir)
  const mediaRoot = path.join(dir, 'media')
  const cacheDir = path.join(dir, 'cache')
  const libraryDir = path.join(mediaRoot, 'Lib')
  await mkdir(libraryDir, { recursive: true })
  await mkdir(cacheDir, { recursive: true })
  await mkdir(path.join(cacheDir, 'thumbs', 'a1', 'v1'), { recursive: true })
  await writeFile(path.join(cacheDir, 'thumbs', 'a1', 'v1', '320.webp'), 'thumb')

  const content = options.content ?? Buffer.alloc(2048, 7)
  const file = path.join(libraryDir, 'clip.mp4')
  if (options.symlinkSource) {
    const realPath = path.join(libraryDir, 'real.mp4')
    await writeFile(realPath, content)
    await symlink(realPath, file)
  } else {
    await writeFile(file, content)
  }
  const info = await stat(file)

  const db = openDatabase(':memory:')
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
    dataDir: dir,
    cacheDir,
    mediaRoot,
    hwaccel: null,
    pollMs: 0,
    once: true,
    gpuResource: 'gpu:0',
    workerId: 'test',
    scanDeleteGuardRatio: 0.2,
    scanDeleteForce: false,
    asrResultDir: path.join(dir, 'asr-results'),
    translationResultDir: path.join(dir, 'asr-results'),
  }

  return { dir, mediaRoot, cacheDir, libraryDir, file, db, config }
}

function requestDelete(db: Db, key = 'req-1'): FileMutationRecord {
  const result = createDeleteMutation(db, {
    assetId: 'a1',
    libraryId: 'lib1',
    userId: 'u1',
    requestKey: `u1:${key}`,
    requestedFileVersion: 1,
    sourceRel: 'clip.mp4',
    now: Date.now(),
  })
  return result.record
}

async function step(db: Db, config: WorkerConfig, workerId = 'w1'): Promise<FileMutationRecord | null> {
  const now = Date.now()
  const claimed = claimNextMutation(db, now, { workerId, leaseMs: 60_000 })
  if (!claimed) return null
  const ctx: MutationContext = {
    db,
    config,
    logger: silentLogger,
    fence: { workerId, leaseEpoch: claimed.leaseEpoch, now: Date.now() },
  }
  await executeDeleteMutation(ctx, claimed)
  releaseMutationLease(db, claimed.id, { ...ctx.fence, now: Date.now() })
  return getFileMutation(db, claimed.id)
}

async function drain(db: Db, config: WorkerConfig): Promise<FileMutationRecord> {
  let current = getFileMutation(db, 'unused')
  for (let i = 0; i < 8; i += 1) {
    const next = await step(db, config)
    if (!next) break
    current = next
    if (['completed', 'blocked', 'cancelled_pre_commit'].includes(next.state)) break
  }
  if (!current) throw new Error('no mutation ran')
  return current
}

describe('quarantine delete mutation', () => {
  test('moves the file through quarantine and finishes with the original gone', async () => {
    const h = await setup()
    const created = requestDelete(h.db)
    expect(created.state).toBe('requested')

    const done = await drain(h.db, h.config)
    expect(done.state).toBe('completed')
    expect(await exists(h.file)).toBe(false)
    expect(await exists(path.join(h.cacheDir, 'thumbs', 'a1'))).toBe(false)
    expect(getMutationAsset(h.db, 'a1')).toBeNull()

    const quarantineRoot = path.join(h.mediaRoot, '.mediavault-quarantine')
    const left = await readdir(quarantineRoot).catch(() => [])
    expect(left).toEqual([])
    h.db.close()
  })

  test('returns the same operation for a repeated request key', async () => {
    const h = await setup()
    const first = requestDelete(h.db, 'same-key')
    const second = requestDelete(h.db, 'same-key')
    expect(second.id).toBe(first.id)
    expect(h.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM file_mutations').get()?.n).toBe(1)
    h.db.close()
  })

  test('blocks when the library is not online and leaves the file alone', async () => {
    const h = await setup()
    markLibraryFailure(h.db, { libraryId: 'lib1', state: 'OFFLINE', errorCode: 'root_missing', now: 2 })
    requestDelete(h.db)
    const done = await drain(h.db, h.config)
    expect(done.state).toBe('blocked')
    expect(done.errorCode).toBe('source_offline')
    expect(await exists(h.file)).toBe(true)
    expect(getMutationAsset(h.db, 'a1')?.deletedAt).toBeNull()
    h.db.close()
  })

  test('blocks when the file version moved past the request', async () => {
    const h = await setup()
    requestDelete(h.db)
    h.db.query('UPDATE assets SET file_version = 2 WHERE id = ?').run('a1')
    const done = await drain(h.db, h.config)
    expect(done.state).toBe('blocked')
    expect(done.errorCode).toBe('file_version_conflict')
    expect(await exists(h.file)).toBe(true)
    h.db.close()
  })

  test('blocks a symlinked source even when the path is inside the library', async () => {
    const h = await setup({ symlinkSource: true })
    requestDelete(h.db)
    const done = await drain(h.db, h.config)
    expect(done.state).toBe('blocked')
    expect(done.errorCode).toBe('source_not_regular_file')
    expect(await exists(h.file)).toBe(true)
    h.db.close()
  })

  test('blocks when the file changed after indexing', async () => {
    const h = await setup()
    requestDelete(h.db)
    await writeFile(h.file, Buffer.alloc(4096, 1))
    const done = await drain(h.db, h.config)
    expect(done.state).toBe('blocked')
    expect(done.errorCode).toBe('file_identity_mismatch')
    expect(await exists(h.file)).toBe(true)
    h.db.close()
  })

  test('hides the asset as soon as validation owns the tombstone', async () => {
    const h = await setup()
    requestDelete(h.db)
    const validated = await step(h.db, h.config)
    expect(validated?.state).toBe('validated')
    const asset = getMutationAsset(h.db, 'a1')
    expect(asset?.deletedAt).not.toBeNull()
    expect(asset?.pendingDeleteMutationId).toBe(validated!.id)
    h.db.close()
  })

  test('a scan cannot resurrect an asset whose delete is in flight', async () => {
    const h = await setup()
    const created = requestDelete(h.db)
    await step(h.db, h.config)

    // The scanner still sees the file for a moment and would normally touch or
    // update the row, which clears deleted_at and bumps file_version.
    const touched = touchAssets(h.db, ['a1'], 'scan-2')
    expect(touched.size).toBe(0)
    const updated = updateAssetFile(h.db, 'a1', {
      folderId: 'f1',
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 2048,
      mtimeMs: 1,
      width: 1,
      height: 1,
      durationMs: 1,
      takenAt: 1,
      videoCodec: null,
      audioCodec: null,
      container: 'mp4',
      indexedAt: 1,
      scanId: 'scan-2',
    })
    expect(updated).toBe(false)

    const asset = getMutationAsset(h.db, 'a1')
    expect(asset?.deletedAt).not.toBeNull()
    expect(asset?.pendingDeleteMutationId).toBe(created.id)
    expect(asset?.fileVersion).toBe(1)
    h.db.close()
  })

  test('a crash after the rename resumes from the quarantined file', async () => {
    const h = await setup()
    const created = requestDelete(h.db)
    await step(h.db, h.config) // validated
    await step(h.db, h.config) // quarantined
    expect(getFileMutation(h.db, created.id)?.state).toBe('quarantined')
    expect(await exists(h.file)).toBe(false)

    // Simulate a crash that lost the quarantined transition by rewinding the
    // row to validated while the file already sits in quarantine.
    h.db.query("UPDATE file_mutations SET state = 'validated' WHERE id = ?").run(created.id)
    const done = await drain(h.db, h.config)
    expect(done.state).toBe('completed')
    expect(getMutationAsset(h.db, 'a1')).toBeNull()
    h.db.close()
  })

  test('a crash between the DB commit and the purge still finishes', async () => {
    const h = await setup()
    const created = requestDelete(h.db)
    await step(h.db, h.config)
    await step(h.db, h.config)
    await step(h.db, h.config) // db_committed
    expect(getFileMutation(h.db, created.id)?.state).toBe('db_committed')
    expect(getMutationAsset(h.db, 'a1')).toBeNull()

    const done = await drain(h.db, h.config)
    expect(done.state).toBe('completed')
    expect(await exists(path.join(h.cacheDir, 'thumbs', 'a1'))).toBe(false)
    h.db.close()
  })

  test('blocks when the quarantined file disappeared before the commit', async () => {
    const h = await setup()
    const created = requestDelete(h.db)
    await step(h.db, h.config)
    await step(h.db, h.config)
    const quarantined = getFileMutation(h.db, created.id)!
    await rm(path.join(quarantined.quarantineRoot!, quarantined.quarantineRel!))

    const done = await drain(h.db, h.config)
    expect(done.state).toBe('blocked')
    expect(done.errorCode).toBe('quarantine_lost')
    // The asset row must survive: nothing may be guessed from a missing file.
    expect(getMutationAsset(h.db, 'a1')).not.toBeNull()
    h.db.close()
  })

  test('a lost lease cannot write the next state', async () => {
    const h = await setup()
    const created = requestDelete(h.db)
    const now = Date.now()
    const claimed = claimNextMutation(h.db, now, { workerId: 'w1', leaseMs: 60_000 })!
    expect(claimed.leaseEpoch).toBe(1)

    // A second worker takes over after the first lease expires.
    const later = now + 61_000
    const stolen = claimNextMutation(h.db, later, { workerId: 'w2', leaseMs: 60_000 })!
    expect(stolen.leaseEpoch).toBe(2)

    const staleCtx: MutationContext = {
      db: h.db,
      config: h.config,
      logger: silentLogger,
      fence: { workerId: 'w1', leaseEpoch: 1, now: later },
    }
    await executeDeleteMutation(staleCtx, claimed)
    expect(getFileMutation(h.db, created.id)?.state).toBe('requested')
    expect(await exists(h.file)).toBe(true)
    h.db.close()
  })

  test('a missing source at validation is a block, not a guess', async () => {
    const h = await setup()
    const created = requestDelete(h.db)
    const now = Date.now()
    const claimed = claimNextMutation(h.db, now, { workerId: 'w1', leaseMs: 60_000 })!
    await rm(h.libraryDir, { recursive: true, force: true })
    const ctx: MutationContext = {
      db: h.db,
      config: h.config,
      logger: silentLogger,
      fence: { workerId: 'w1', leaseEpoch: claimed.leaseEpoch, now },
    }
    await executeDeleteMutation(ctx, claimed)
    const after = getFileMutation(h.db, created.id)!
    expect(after.state).toBe('blocked')
    expect(after.errorCode).toBe('source_missing')
    h.db.close()
  })
})
