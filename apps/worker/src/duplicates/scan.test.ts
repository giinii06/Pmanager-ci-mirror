import { afterAll, describe, expect, test } from 'bun:test'
import { link, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createLibrary,
  insertAsset,
  listDuplicateGroups,
  openDatabase,
  setDuplicateGroupState,
  upsertFolder,
  type Db,
} from '@mediavault/database'
import type { WorkerConfig } from '../config'
import { scanDuplicates } from './scan'

const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

interface Harness {
  dir: string
  db: Db
  root: string
  config: WorkerConfig
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-duplicates-'))
  dirs.push(dir)
  const mediaRoot = path.join(dir, 'media')
  const root = path.join(mediaRoot, 'Lib')
  await mkdir(root, { recursive: true })

  const db = openDatabase(':memory:')
  createLibrary(db, { id: 'lib1', name: 'Lib', rootPath: 'Lib', createdAt: 1 })
  upsertFolder(db, {
    id: 'f1',
    libraryId: 'lib1',
    parentId: null,
    relativePath: 'Lib',
    name: 'Lib',
    depth: 0,
    scanId: 'seed',
  })

  return {
    dir,
    db,
    root,
    config: {
      dataDir: dir,
      cacheDir: path.join(dir, 'cache'),
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
    },
  }
}

function bytes(size: number, fill: number): Buffer {
  return Buffer.alloc(size, fill)
}

async function record(h: Harness, id: string, relativePath: string, size: number, mtimeMs: number) {
  insertAsset(h.db, {
    id,
    libraryId: 'lib1',
    folderId: 'f1',
    relativePath,
    filename: path.basename(relativePath),
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: size,
    mtimeMs,
    width: null,
    height: null,
    durationMs: null,
    takenAt: 1,
    videoCodec: null,
    audioCodec: null,
    container: 'mp4',
    indexedAt: 1,
    scanId: 'seed',
  })
}

async function addFile(h: Harness, id: string, name: string, content: Buffer): Promise<string> {
  const file = path.join(h.root, name)
  await writeFile(file, content)
  const info = await stat(file)
  await record(h, id, name, info.size, Math.round(info.mtimeMs))
  return file
}

describe('the duplicate scan', () => {
  test('two files with the same bytes become one group of two', async () => {
    const h = await harness()
    await addFile(h, 'a1', 'one.mp4', bytes(2048, 9))
    await addFile(h, 'a2', 'two.mp4', bytes(2048, 9))

    const summary = await scanDuplicates(h.db, h.config)
    expect(summary).toMatchObject({
      candidates: 2,
      scanned: 2,
      hashed: 2,
      reused: 0,
      missing: 0,
      changed: 0,
      refused: 0,
      skipped: 0,
      groups: 1,
      members: 2,
      hardlinked: 0,
    })

    const page = listDuplicateGroups(h.db, { kind: 'exact', state: 'all', limit: 10 })
    expect(page.groups).toHaveLength(1)
    const group = page.groups[0]!
    expect(group.kind).toBe('exact')
    expect(group.memberCount).toBe(2)
    expect(group.totalBytes).toBe(4096)
    expect(group.members.map((member) => member.filename)).toEqual(['one.mp4', 'two.mp4'])
    expect(group.members.every((member) => member.confidence === 1)).toBe(true)
    expect(group.members.every((member) => member.sameInode === false)).toBe(true)
    h.db.close()
  })

  test('two files of the same size with different bytes make no group', async () => {
    const h = await harness()
    await addFile(h, 'a1', 'one.mp4', bytes(2048, 9))
    await addFile(h, 'a2', 'two.mp4', bytes(2048, 4))

    const summary = await scanDuplicates(h.db, h.config)
    expect(summary).toMatchObject({ candidates: 2, scanned: 2, hashed: 2, groups: 0, members: 0 })
    expect(listDuplicateGroups(h.db, { kind: 'exact', state: 'all', limit: 10 }).groups).toEqual([])
    h.db.close()
  })

  test('a third file of another size is never even a candidate', async () => {
    const h = await harness()
    await addFile(h, 'a1', 'one.mp4', bytes(2048, 9))
    await addFile(h, 'a2', 'two.mp4', bytes(2048, 9))
    await addFile(h, 'a3', 'alone.mp4', bytes(4096, 1))

    const summary = await scanDuplicates(h.db, h.config)
    expect(summary).toMatchObject({ candidates: 2, scanned: 2, groups: 1, members: 2 })
    h.db.close()
  })

  test('a hardlink pair is one group and both members are marked', async () => {
    const h = await harness()
    const target = await addFile(h, 'a1', 'one.mp4', bytes(2048, 9))
    const linkPath = path.join(h.root, 'linked.mp4')
    await link(target, linkPath)
    const info = await stat(linkPath)
    await record(h, 'a2', 'linked.mp4', info.size, Math.round(info.mtimeMs))

    const summary = await scanDuplicates(h.db, h.config)
    expect(summary).toMatchObject({ candidates: 2, groups: 1, members: 2, hardlinked: 2 })

    const group = listDuplicateGroups(h.db, { kind: 'exact', state: 'all', limit: 10 }).groups[0]!
    expect(group.members.map((member) => member.sameInode)).toEqual([true, true])
    h.db.close()
  })

  test('a missing file is counted and the scan still finishes', async () => {
    const h = await harness()
    await addFile(h, 'a1', 'one.mp4', bytes(2048, 9))
    await record(h, 'a2', 'gone.mp4', 2048, 1_000)

    const summary = await scanDuplicates(h.db, h.config)
    expect(summary).toMatchObject({ candidates: 2, scanned: 1, missing: 1, groups: 0 })
    h.db.close()
  })

  test('a symlink that leaves the library root is refused', async () => {
    const h = await harness()
    await addFile(h, 'a1', 'one.mp4', bytes(2048, 9))
    const outside = path.join(h.dir, 'outside.mp4')
    await writeFile(outside, bytes(2048, 9))
    const linkPath = path.join(h.root, 'escape.mp4')
    await symlink(outside, linkPath)
    const info = await stat(linkPath)
    await record(h, 'a2', 'escape.mp4', info.size, Math.round(info.mtimeMs))

    const summary = await scanDuplicates(h.db, h.config)
    expect(summary).toMatchObject({ candidates: 2, scanned: 1, refused: 1, groups: 0 })
    h.db.close()
  })

  test('a rescan reads nothing again and keeps the reviewer decision', async () => {
    const h = await harness()
    await addFile(h, 'a1', 'one.mp4', bytes(2048, 9))
    await addFile(h, 'a2', 'two.mp4', bytes(2048, 9))

    await scanDuplicates(h.db, h.config)
    const id = listDuplicateGroups(h.db, { kind: 'exact', state: 'all', limit: 10 }).groups[0]!.id
    expect(setDuplicateGroupState(h.db, id, 'kept', Date.now())?.state).toBe('kept')

    const again = await scanDuplicates(h.db, h.config)
    expect(again).toMatchObject({ candidates: 2, scanned: 2, hashed: 0, reused: 2, groups: 1 })
    expect(listDuplicateGroups(h.db, { kind: 'exact', state: 'all', limit: 10 }).groups[0]!.state).toBe(
      'kept',
    )
    h.db.close()
  })

  test('a scan leaves no trace of a file operation', async () => {
    const h = await harness()
    await addFile(h, 'a1', 'one.mp4', bytes(2048, 9))
    await addFile(h, 'a2', 'two.mp4', bytes(2048, 9))
    await addFile(h, 'a3', 'other.mp4', bytes(2048, 4))

    await scanDuplicates(h.db, h.config)
    await scanDuplicates(h.db, h.config)

    const count = (table: string) =>
      h.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n
    expect(count('file_mutations')).toBe(0)
    expect(count('mutation_events')).toBe(0)
    expect(count('jobs')).toBe(0)
    expect(
      h.db
        .query<{ n: number }, []>(
          'SELECT COUNT(*) AS n FROM assets WHERE pending_delete_mutation_id IS NOT NULL',
        )
        .get()!.n,
    ).toBe(0)
    h.db.close()
  })
})
