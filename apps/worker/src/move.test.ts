import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  addTagToAsset,
  claimNextMutation,
  createCopyMutation,
  createLibrary,
  createMoveMutation,
  createTag,
  createUser,
  getFileMutation,
  getMutationAsset,
  insertAsset,
  markLibraryHealthy,
  openDatabase,
  releaseMutationLease,
  upsertFolder,
  type Db,
  type FileMutationRecord,
} from '@mediavault/database'
import type { WorkerConfig } from './config'
import type { MutationContext } from './mutations/delete'
import { executeMoveMutation } from './mutations/move'

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

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-move-'))
  dirs.push(dir)
  const mediaRoot = path.join(dir, 'media')
  const cacheDir = path.join(dir, 'cache')
  const libraryDir = path.join(mediaRoot, 'Lib')
  const targetDir = path.join(mediaRoot, 'Dest')
  await mkdir(libraryDir, { recursive: true })
  await mkdir(targetDir, { recursive: true })
  await mkdir(path.join(cacheDir, 'thumbs', 'a1', 'v1'), { recursive: true })
  await writeFile(path.join(cacheDir, 'thumbs', 'a1', 'v1', '320.webp'), 'thumb')

  const content = Buffer.alloc(4096, 9)
  const file = path.join(libraryDir, 'clip.mp4')
  await writeFile(file, content)
  const info = await stat(file)

  const db = openDatabase(':memory:')
  createUser(db, { id: 'u1', username: 'owner', passwordHash: 'x', createdAt: 1 })
  createLibrary(db, { id: 'lib1', name: 'Lib', rootPath: 'Lib', createdAt: 1 })
  createLibrary(db, { id: 'lib2', name: 'Dest', rootPath: 'Dest', createdAt: 1 })
  markLibraryHealthy(db, { libraryId: 'lib1', rootIdentity: '1:2', now: 1 })
  markLibraryHealthy(db, { libraryId: 'lib2', rootIdentity: '3:4', now: 1 })
  const sourceFolder = upsertFolder(db, {
    id: 'f1',
    libraryId: 'lib1',
    parentId: null,
    relativePath: '',
    name: 'Lib',
    depth: 0,
    scanId: 's1',
    createdAt: 1,
  })
  const targetFolder = upsertFolder(db, {
    id: 'f2',
    libraryId: 'lib2',
    parentId: null,
    relativePath: '',
    name: 'Dest',
    depth: 0,
    scanId: 's1',
    createdAt: 1,
  })
  insertAsset(db, {
    id: 'a1',
    libraryId: 'lib1',
    folderId: sourceFolder,
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

  return { dir, mediaRoot, cacheDir, libraryDir, targetDir, file, content, db, config }
}

function requestMove(
  db: Db,
  kind: 'move' | 'copy',
  targetRel: string,
  key = 'req-1',
): FileMutationRecord {
  const input = {
    assetId: 'a1',
    libraryId: 'lib1',
    userId: 'u1',
    requestKey: `u1:${key}`,
    requestedFileVersion: 1,
    sourceRel: 'clip.mp4',
    targetLibraryId: 'lib2',
    targetRel,
    now: Date.now(),
  }
  return (kind === 'move' ? createMoveMutation(db, input) : createCopyMutation(db, input)).record
}

async function step(db: Db, config: WorkerConfig, workerId = 'w1'): Promise<FileMutationRecord | null> {
  const claimed = claimNextMutation(db, Date.now(), { workerId, leaseMs: 60_000 })
  if (!claimed) return null
  const ctx: MutationContext = {
    db,
    config,
    logger: silentLogger,
    fence: { workerId, leaseEpoch: claimed.leaseEpoch, now: Date.now() },
  }
  await executeMoveMutation(ctx, claimed)
  releaseMutationLease(db, claimed.id, { ...ctx.fence, now: Date.now() })
  return getFileMutation(db, claimed.id)
}

async function drain(db: Db, config: WorkerConfig): Promise<FileMutationRecord> {
  let current: FileMutationRecord | null = null
  for (let i = 0; i < 8; i += 1) {
    const next = await step(db, config)
    if (!next) break
    current = next
    if (['completed', 'blocked', 'cancelled_pre_commit'].includes(next.state)) break
  }
  if (!current) throw new Error('no mutation ran')
  return current
}

describe('move engine', () => {
  test('renames into another library, keeps the asset row and its derived data', async () => {
    const h = await setup()
    const tag = createTag(h.db, 't1', 'keep', 1)
    addTagToAsset(h.db, 'a1', tag.id, 1)
    const created = requestMove(h.db, 'move', 'sub/clip.mp4')
    expect(created.state).toBe('requested')

    const done = await drain(h.db, h.config)
    expect(done.state).toBe('completed')

    const moved = path.join(h.targetDir, 'sub', 'clip.mp4')
    expect(await exists(h.file)).toBe(false)
    expect(await readFile(moved)).toEqual(h.content)

    const asset = getMutationAsset(h.db, 'a1')
    expect(asset?.libraryId).toBe('lib2')
    expect(asset?.relativePath).toBe('sub/clip.mp4')
    expect(asset?.filename).toBe('clip.mp4')
    expect(asset?.fileVersion).toBe(1)
    expect(asset?.pendingDeleteMutationId).toBeNull()
    expect(asset?.deletedAt).toBeNull()

    const folder = h.db
      .query<{ id: string }, [string, string]>(
        'SELECT id FROM folders WHERE library_id = ? AND relative_path = ?',
      )
      .get('lib2', 'sub')
    expect(folder).not.toBeNull()

    const tagged = h.db
      .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM asset_tags WHERE asset_id = ?')
      .get('a1')?.n
    expect(tagged).toBe(1)
    // The move keeps cached derivatives: they are keyed by asset id and version.
    expect(await exists(path.join(h.cacheDir, 'thumbs', 'a1', 'v1', '320.webp'))).toBe(true)

    const quarantine = await readdir(path.join(h.mediaRoot, '.mediavault-quarantine')).catch(() => [])
    expect(quarantine).toEqual([])
    h.db.close()
  })

  test('a copy publishes a verified file, leaves the source and queues a scan', async () => {
    const h = await setup()
    requestMove(h.db, 'copy', 'clip.mp4')
    const done = await drain(h.db, h.config)
    expect(done.state).toBe('completed')

    const copy = path.join(h.targetDir, 'clip.mp4')
    expect(await readFile(h.file)).toEqual(h.content)
    expect(await readFile(copy)).toEqual(h.content)

    const asset = getMutationAsset(h.db, 'a1')
    expect(asset?.libraryId).toBe('lib1')
    expect(asset?.relativePath).toBe('clip.mp4')
    expect(asset?.pendingDeleteMutationId).toBeNull()

    const scans = h.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM jobs WHERE kind = 'scan_library' AND library_id = 'lib2'",
      )
      .get()?.n
    expect(scans).toBe(1)
    const staging = await readdir(h.targetDir)
    expect(staging.filter((name) => name.endsWith('.tmp'))).toEqual([])
    h.db.close()
  })

  test('a verified staging copy is published and the source quarantined before the commit', async () => {
    const h = await setup()
    const created = requestMove(h.db, 'move', 'sub/clip.mp4')
    const prepared = await step(h.db, h.config)
    expect(prepared?.state).toBe('validated')

    // Reproduce the state stageCopy leaves behind when rename(2) reports EXDEV:
    // a hashed staging file next to the target while the source is untouched.
    const manifest = JSON.parse(prepared!.manifestJson!) as Record<string, unknown> & {
      stagingRel: string
    }
    const staging = path.join(h.targetDir, manifest.stagingRel)
    await mkdir(path.dirname(staging), { recursive: true })
    await copyFile(h.file, staging)
    const hash = createHash('sha256').update(h.content).digest('hex')
    h.db
      .query<null, [string, string]>('UPDATE file_mutations SET manifest_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...manifest, hash, phase: 'copied' }), created.id)

    const done = await drain(h.db, h.config)
    expect(done.state).toBe('completed')
    expect(await exists(h.file)).toBe(false)
    expect(await readFile(path.join(h.targetDir, 'sub', 'clip.mp4'))).toEqual(h.content)
    expect(getMutationAsset(h.db, 'a1')?.relativePath).toBe('sub/clip.mp4')

    const quarantine = await readdir(path.join(h.mediaRoot, '.mediavault-quarantine'))
    expect(quarantine).toEqual([])
    h.db.close()
  })

  test('a crash after the rename resumes without copying the file again', async () => {
    const h = await setup()
    const created = requestMove(h.db, 'move', 'sub/clip.mp4')
    await step(h.db, h.config)
    const target = path.join(h.targetDir, 'sub', 'clip.mp4')
    await mkdir(path.dirname(target), { recursive: true })
    await rename(h.file, target)

    const done = await drain(h.db, h.config)
    expect(done.state).toBe('completed')
    expect(getMutationAsset(h.db, 'a1')?.libraryId).toBe('lib2')
    expect(getMutationAsset(h.db, 'a1')?.relativePath).toBe('sub/clip.mp4')
    expect(await readFile(target)).toEqual(h.content)
    expect(await exists(h.file)).toBe(false)
    expect(await exists(path.join(h.targetDir, 'sub', `clip.mp4.${created.id}.tmp`))).toBe(false)
    h.db.close()
  })

  test('a crash after the DB commit finishes from the recorded location', async () => {
    const h = await setup()
    const created = requestMove(h.db, 'move', 'sub/clip.mp4')
    const done = await drain(h.db, h.config)
    expect(done.state).toBe('completed')

    // Rewind the state machine to simulate a crash between the location update
    // and the completed transition.
    h.db
      .query<null, [string]>("UPDATE file_mutations SET state = 'validated', completed_at = NULL WHERE id = ?")
      .run(created.id)
    const resumed = await drain(h.db, h.config)
    expect(resumed.state).toBe('completed')
    expect(getMutationAsset(h.db, 'a1')?.relativePath).toBe('sub/clip.mp4')
    expect(await readdir(path.join(h.targetDir, 'sub'))).toEqual(['clip.mp4'])
    h.db.close()
  })

  test('refuses a target another asset owns and leaves the source alone', async () => {
    const h = await setup()
    insertAsset(h.db, {
      id: 'a2',
      libraryId: 'lib2',
      folderId: 'f2',
      relativePath: 'clip.mp4',
      filename: 'clip.mp4',
      kind: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 10,
      mtimeMs: 1,
      width: null,
      height: null,
      durationMs: null,
      takenAt: 1,
      videoCodec: null,
      audioCodec: null,
      container: null,
      indexedAt: 1,
      scanId: 's1',
    })
    requestMove(h.db, 'move', 'clip.mp4')
    const done = await drain(h.db, h.config)
    expect(done.state).toBe('blocked')
    expect(done.errorCode).toBe('target_exists')
    expect(await exists(h.file)).toBe(true)
    expect(getMutationAsset(h.db, 'a1')?.libraryId).toBe('lib1')
    expect(getMutationAsset(h.db, 'a1')?.pendingDeleteMutationId).toBeNull()
    h.db.close()
  })

  test('a crash after the target publish and source quarantine still commits', async () => {
    const h = await setup()
    const created = requestMove(h.db, 'move', 'sub/clip.mp4')
    const prepared = await step(h.db, h.config)
    expect(prepared?.state).toBe('validated')

    // Reproduce the crash window of a cross-device move: the verified copy is
    // already published and the source already sits in quarantine, while the
    // database still points at the old path.
    const manifest = JSON.parse(prepared!.manifestJson!) as Record<string, unknown> & {
      stagingRel: string
    }
    const target = path.join(h.targetDir, 'sub', 'clip.mp4')
    const staging = path.join(h.targetDir, manifest.stagingRel)
    await mkdir(path.dirname(staging), { recursive: true })
    await copyFile(h.file, staging)
    const hash = createHash('sha256').update(h.content).digest('hex')
    const quarantine = path.join(h.mediaRoot, '.mediavault-quarantine', created.id, 'clip.mp4')
    await mkdir(path.dirname(quarantine), { recursive: true })
    await rename(staging, target)
    await rename(h.file, quarantine)
    h.db
      .query<null, [string, string]>('UPDATE file_mutations SET manifest_json = ? WHERE id = ?')
      .run(
        JSON.stringify({
          ...manifest,
          hash,
          phase: 'copied',
          quarantine: { root: h.mediaRoot, rel: `.mediavault-quarantine/${created.id}/clip.mp4` },
        }),
        created.id,
      )

    const done = await drain(h.db, h.config)
    expect(done.state).toBe('completed')
    expect(await readFile(target)).toEqual(h.content)
    expect(await exists(h.file)).toBe(false)
    expect(getMutationAsset(h.db, 'a1')?.relativePath).toBe('sub/clip.mp4')
    expect(await readdir(path.join(h.mediaRoot, '.mediavault-quarantine'))).toEqual([])
    h.db.close()
  })

  test('a copy refuses a target that already holds different bytes', async () => {
    const h = await setup()
    requestMove(h.db, 'copy', 'clip.mp4')
    await step(h.db, h.config)
    const target = path.join(h.targetDir, 'clip.mp4')
    await writeFile(target, Buffer.alloc(4096, 3))

    const done = await drain(h.db, h.config)
    expect(done.state).toBe('blocked')
    expect(done.errorCode).toBe('target_exists')
    expect(await readFile(target)).toEqual(Buffer.alloc(4096, 3))
    expect(await readFile(h.file)).toEqual(h.content)
    h.db.close()
  })

  test('a target directory swapped for a symlink after validation is refused', async () => {
    const h = await setup()
    requestMove(h.db, 'move', 'sub/clip.mp4')
    await step(h.db, h.config)
    const outside = path.join(h.dir, 'outside')
    await mkdir(outside, { recursive: true })
    await rm(path.join(h.targetDir, 'sub'), { recursive: true, force: true })
    await symlink(outside, path.join(h.targetDir, 'sub'))

    const done = await drain(h.db, h.config)
    expect(done.state).toBe('blocked')
    expect(done.errorCode).toBe('target_outside_library')
    expect(await exists(h.file)).toBe(true)
    expect(await readdir(outside)).toEqual([])
    h.db.close()
  })

  test('refuses a target that a soft-deleted asset still owns', async () => {
    const h = await setup()
    insertAsset(h.db, {
      id: 'a2',
      libraryId: 'lib2',
      folderId: 'f2',
      relativePath: 'clip.mp4',
      filename: 'clip.mp4',
      kind: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 10,
      mtimeMs: 1,
      width: null,
      height: null,
      durationMs: null,
      takenAt: 1,
      videoCodec: null,
      audioCodec: null,
      container: null,
      indexedAt: 1,
      scanId: 's1',
    })
    h.db.query("UPDATE assets SET deleted_at = 5 WHERE id = 'a2'").run()
    requestMove(h.db, 'move', 'clip.mp4')
    const done = await drain(h.db, h.config)
    expect(done.state).toBe('blocked')
    expect(done.errorCode).toBe('target_soft_deleted')
    expect(await exists(h.file)).toBe(true)
    h.db.close()
  })

  test('refuses a target directory that resolves outside the library', async () => {
    const h = await setup()
    const outside = path.join(h.dir, 'outside')
    await mkdir(outside, { recursive: true })
    await symlink(outside, path.join(h.targetDir, 'evil'))
    requestMove(h.db, 'move', 'evil/clip.mp4')
    const done = await drain(h.db, h.config)
    expect(done.state).toBe('blocked')
    expect(done.errorCode).toBe('target_outside_library')
    expect(await exists(h.file)).toBe(true)
    expect(await readdir(outside)).toEqual([])
    h.db.close()
  })

  test('refuses a source whose bytes changed since indexing', async () => {
    const h = await setup()
    requestMove(h.db, 'move', 'clip.mp4')
    await writeFile(h.file, Buffer.alloc(8192, 1))
    const done = await drain(h.db, h.config)
    expect(done.state).toBe('blocked')
    expect(done.errorCode).toBe('file_identity_mismatch')
    expect(await exists(h.file)).toBe(true)
    h.db.close()
  })

  test('blocks a move while the target library is offline', async () => {
    const h = await setup()
    h.db
      .query<null, []>(
        "UPDATE library_health SET state = 'OFFLINE' WHERE library_id = 'lib2'",
      )
      .run()
    requestMove(h.db, 'move', 'clip.mp4')
    const done = await drain(h.db, h.config)
    expect(done.state).toBe('blocked')
    expect(done.errorCode).toBe('target_offline')
    expect(await exists(h.file)).toBe(true)
    h.db.close()
  })
})
