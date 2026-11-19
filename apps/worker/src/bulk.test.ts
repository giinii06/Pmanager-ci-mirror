import { afterAll, describe, expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  addTagToAsset,
  attachBulkItemMutation,
  claimNextBulkItem,
  claimNextMutation,
  createBulkOperation,
  createDeleteMutation,
  createLibrary,
  createSceneJob,
  createTag,
  createUser,
  getBulkOperation,
  getBulkOperationCounts,
  getTag,
  insertAsset,
  listBulkOperationItems,
  markAssetPendingDelete,
  markLibraryHealthy,
  openDatabase,
  releaseMutationLease,
  requestBulkCancel,
  retryBulkItems,
  upsertFolder,
  type BulkOperationKind,
  type Db,
} from '@mediavault/database'
import type { WorkerConfig } from './config'
import { runBulkOperationOnce } from './bulk/worker'
import { runMutationLoop } from './mutations/worker'

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
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-bulk-'))
  dirs.push(dir)
  const mediaRoot = path.join(dir, 'media')
  const cacheDir = path.join(dir, 'cache')
  const libraryDir = path.join(mediaRoot, 'Lib')
  await mkdir(libraryDir, { recursive: true })
  await mkdir(cacheDir, { recursive: true })

  const db = openDatabase(':memory:')
  createUser(db, { id: 'u1', username: 'owner', passwordHash: 'x', createdAt: 1 })
  createLibrary(db, { id: 'lib1', name: 'Lib', rootPath: 'Lib', createdAt: 1 })
  markLibraryHealthy(db, { libraryId: 'lib1', rootIdentity: '1:2', now: 1 })
  const folder = upsertFolder(db, {
    id: 'f1',
    libraryId: 'lib1',
    parentId: null,
    relativePath: '',
    name: 'Lib',
    depth: 0,
    scanId: 's1',
    createdAt: 1,
  })

  const assets: string[] = []
  for (const id of ['a1', 'a2']) {
    const file = path.join(libraryDir, `${id}.mp4`)
    await writeFile(file, Buffer.alloc(1024, id === 'a1' ? 1 : 2))
    const info = await stat(file)
    insertAsset(db, {
      id,
      libraryId: 'lib1',
      folderId: folder,
      relativePath: `${id}.mp4`,
      filename: `${id}.mp4`,
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
    assets.push(id)
  }

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
    fileMutationEnabled: true,
    bulkOperationsEnabled: true,
    bulkPollMs: 5,
    mutationPollMs: 5,
    asrResultDir: path.join(dir, 'asr-results'),
    translationResultDir: path.join(dir, 'asr-results'),
  }

  return { dir, mediaRoot, cacheDir, libraryDir, db, config, assets }
}

function createOperation(
  db: Db,
  kind: BulkOperationKind,
  options: {
    id?: string
    assetIds?: string[]
    params?: Record<string, unknown>
    now?: number
  } = {},
) {
  const assetIds = options.assetIds ?? ['a1', 'a2']
  return createBulkOperation(db, {
    id: options.id ?? 'op1',
    userId: 'u1',
    kind,
    selectionKind: 'ids',
    selectionJson: JSON.stringify({ kind: 'ids', assetIds }),
    snapshotCount: assetIds.length,
    snapshotHash: 'hash-1',
    snapshotGeneration: 'gen-1',
    paramsJson: JSON.stringify(options.params ?? {}),
    requestKey: `u1:${options.id ?? 'op1'}`,
    items: assetIds.map((assetId) => ({
      assetId,
      filename: `${assetId}.mp4`,
      relativePath: `${assetId}.mp4`,
      sizeBytes: 1024,
    })),
    now: options.now ?? Date.now(),
  }).record
}

function itemStates(db: Db, operationId: string): string[] {
  return listBulkOperationItems(db, operationId).map((item) => item.state)
}

function run(db: Db, config: WorkerConfig) {
  return runBulkOperationOnce(db, config, silentLogger, new AbortController().signal)
}

const MODELS = {
  asr: { modelRevision: 'asr-r1', alignerRevision: 'al-r1', pipelineVersion: 'p1' },
  scene: {
    modelId: 'scene-model',
    modelRevision: 'scene-r1',
    modelSha256: 'scene-sha',
    pipelineVersion: 'p1',
    dimensions: 8,
    windowMs: 1000,
    overlapMs: 0,
  },
  embedding: {
    modelId: 'embed-model',
    modelRevision: 'embed-r1',
    modelSha256: 'embed-sha',
    pipelineVersion: 'p1',
    dimensions: 16,
  },
  translation: {
    modelId: 'mt-model',
    modelRevision: 'mt-r1',
    modelSha256: 'mt-sha',
    promptVersion: 'prompt-1',
    pipelineVersion: 'p1',
    targetLanguage: 'ko',
  },
}

describe('bulk worker', () => {
  test('adds a tag to every selected asset', async () => {
    const h = await setup()
    const tag = createTag(h.db, 't1', 'favorite', 1)
    createOperation(h.db, 'tag_add', { params: { tagId: tag.id } })

    expect(await run(h.db, h.config)).toBe(true)
    expect(getBulkOperation(h.db, 'op1')?.state).toBe('completed')
    expect(getBulkOperationCounts(h.db, 'op1').succeeded).toBe(2)
    const tagged = h.db
      .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM asset_tags WHERE tag_id = ?')
      .get('t1')?.n
    expect(tagged).toBe(2)
    h.db.close()
  })

  test('removes a tag that only some assets carry', async () => {
    const h = await setup()
    const tag = createTag(h.db, 't1', 'favorite', 1)
    addTagToAsset(h.db, 'a1', tag.id, 1)
    createOperation(h.db, 'tag_remove', { params: { tagId: tag.id } })

    expect(await run(h.db, h.config)).toBe(true)
    expect(getBulkOperation(h.db, 'op1')?.state).toBe('completed')
    expect(itemStates(h.db, 'op1')).toEqual(['succeeded', 'succeeded'])
    const tagged = h.db
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM asset_tags')
      .get()?.n
    expect(tagged).toBe(0)
    h.db.close()
  })

  test('holds the item when the tag disappeared before the run', async () => {
    const h = await setup()
    createOperation(h.db, 'tag_add', { params: { tagId: 'gone' } })
    expect(await run(h.db, h.config)).toBe(true)
    expect(getBulkOperation(h.db, 'op1')?.state).toBe('completed_with_errors')
    expect(itemStates(h.db, 'op1')).toEqual(['held', 'held'])
    expect(h.db.query<{ code: string }, []>('SELECT error_code AS code FROM bulk_operation_items LIMIT 1').get()?.code).toBe(
      'tag_missing',
    )
    h.db.close()
  })

  test('bumps the poster version and queues one thumbnail job per asset', async () => {
    const h = await setup()
    createOperation(h.db, 'poster')

    expect(await run(h.db, h.config)).toBe(true)
    expect(getBulkOperation(h.db, 'op1')?.state).toBe('completed')
    const versions = h.db
      .query<{ id: string; version: number }, []>(
        'SELECT id, poster_version AS version FROM assets ORDER BY id',
      )
      .all()
    expect(versions).toEqual([
      { id: 'a1', version: 2 },
      { id: 'a2', version: 2 },
    ])
    const jobs = h.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM jobs WHERE kind = 'thumbnail' AND state = 'queued'",
      )
      .get()?.n
    expect(jobs).toBe(2)
    h.db.close()
  })

  test('reanalyze queues a forced scene job even when the fingerprint is current', async () => {
    const h = await setup()
    createSceneJob(
      h.db,
      {
        id: 'scene-old',
        assetId: 'a1',
        fileVersion: 1,
        modelId: MODELS.scene.modelId,
        modelRevision: MODELS.scene.modelRevision,
        modelSha256: MODELS.scene.modelSha256,
        pipelineVersion: MODELS.scene.pipelineVersion,
        dimensions: MODELS.scene.dimensions,
        windowMs: MODELS.scene.windowMs,
        overlapMs: MODELS.scene.overlapMs,
      },
      1,
    )
    h.db.query("UPDATE scene_jobs SET state = 'completed' WHERE id = 'scene-old'").run()
    createOperation(h.db, 'reanalyze', {
      assetIds: ['a1'],
      params: { stages: ['scenes'], models: MODELS },
    })

    expect(await run(h.db, h.config)).toBe(true)
    expect(getBulkOperation(h.db, 'op1')?.state).toBe('completed')
    const scene = h.db
      .query<{ state: string; revision: string }, []>(
        "SELECT state, model_revision AS revision FROM scene_jobs WHERE asset_id = 'a1'",
      )
      .get()
    expect(scene).toEqual({ state: 'queued', revision: 'scene-r1' })
    h.db.close()
  })

  test('reanalyze queues ASR for a video asset', async () => {
    const h = await setup()
    createOperation(h.db, 'reanalyze', {
      assetIds: ['a1'],
      params: { stages: ['transcript'], models: MODELS },
    })
    expect(await run(h.db, h.config)).toBe(true)
    const asr = h.db
      .query<{ state: string; revision: string }, []>(
        "SELECT state, model_revision AS revision FROM asr_jobs WHERE asset_id = 'a1'",
      )
      .get()
    expect(asr).toEqual({ state: 'queued', revision: 'asr-r1' })
    h.db.close()
  })

  test('export writes a CSV with the item snapshot', async () => {
    const h = await setup()
    createOperation(h.db, 'export')
    expect(await run(h.db, h.config)).toBe(true)
    expect(getBulkOperation(h.db, 'op1')?.state).toBe('completed')

    const csv = await readFile(path.join(h.dir, 'exports', 'op1.csv'), 'utf8')
    expect(csv.startsWith('\uFEFF')).toBe(true)
    const lines = csv.replace('\uFEFF', '').trim().split('\n')
    expect(lines[0]).toBe('asset_id,filename,relative_path,size_bytes,state')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain('a1,a1.mp4,a1.mp4,1024,succeeded')
    h.db.close()
  })

  test('a delete item is delegated to the mutation engine and waits for it', async () => {
    const h = await setup()
    const operation = createOperation(h.db, 'delete', { assetIds: ['a1'], params: { confirm: 'delete' } })
    const controller = new AbortController()
    const mutationLoop = runMutationLoop(h.db, h.config, silentLogger, controller.signal)

    expect(await run(h.db, h.config)).toBe(true)
    controller.abort('done')
    await mutationLoop

    expect(getBulkOperation(h.db, operation.id)?.state).toBe('completed')
    expect(itemStates(h.db, operation.id)).toEqual(['succeeded'])
    expect(await exists(path.join(h.libraryDir, 'a1.mp4'))).toBe(false)
    const asset = h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM assets WHERE id = 'a1'").get()?.n
    expect(asset).toBe(0)
    const key = h.db
      .query<{ key: string }, []>("SELECT request_key AS key FROM file_mutations WHERE kind = 'delete'")
      .get()?.key
    expect(key).toStartWith(`bulk:${operation.id}:`)
    h.db.close()
  })

  test('a cancel before the run finishes the operation without starting work', async () => {
    const h = await setup()
    const tag = createTag(h.db, 't1', 'favorite', 1)
    createOperation(h.db, 'tag_add', { params: { tagId: tag.id } })
    expect(requestBulkCancel(h.db, 'op1', 'u1', Date.now())).toBe('cancelled')

    expect(await run(h.db, h.config)).toBe(false)
    expect(getBulkOperation(h.db, 'op1')?.state).toBe('cancelled')
    expect(itemStates(h.db, 'op1')).toEqual(['cancelled', 'cancelled'])
    expect(getTag(h.db, 't1')).not.toBeNull()
    h.db.close()
  })

  test('a cancelling operation with only pending items is finalized as cancelled', async () => {
    const h = await setup()
    createOperation(h.db, 'poster')
    h.db.query("UPDATE bulk_operations SET state = 'cancelling' WHERE id = 'op1'").run()

    expect(await run(h.db, h.config)).toBe(true)
    expect(getBulkOperation(h.db, 'op1')?.state).toBe('cancelled')
    expect(itemStates(h.db, 'op1')).toEqual(['cancelled', 'cancelled'])
    const version = h.db
      .query<{ version: number }, []>("SELECT poster_version AS version FROM assets WHERE id = 'a1'")
      .get()?.version
    expect(version).toBe(1)
    h.db.close()
  })

  test('retrying a held item after the cause clears succeeds', async () => {
    const h = await setup()
    const tag = createTag(h.db, 't1', 'favorite', 1)
    h.db.query("UPDATE assets SET deleted_at = 5 WHERE id = 'a1'").run()
    createOperation(h.db, 'tag_add', { assetIds: ['a1'], params: { tagId: tag.id } })

    expect(await run(h.db, h.config)).toBe(true)
    expect(getBulkOperation(h.db, 'op1')?.state).toBe('completed_with_errors')
    expect(itemStates(h.db, 'op1')).toEqual(['held'])

    h.db.query("UPDATE assets SET deleted_at = NULL WHERE id = 'a1'").run()
    expect(retryBulkItems(h.db, 'op1', 'u1', null, Date.now())).toBe(1)
    expect(await run(h.db, h.config)).toBe(true)
    expect(getBulkOperation(h.db, 'op1')?.state).toBe('completed')
    expect(itemStates(h.db, 'op1')).toEqual(['succeeded'])
    const tagged = h.db
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM asset_tags').get()?.n
    expect(tagged).toBe(1)
    h.db.close()
  })

  test('a restart with the file engine off cancels an untouched file item', async () => {
    const h = await setup()
    const operation = createOperation(h.db, 'delete', {
      assetIds: ['a1'],
      params: { confirm: 'delete' },
    })
    const now = Date.now()
    const mutation = createDeleteMutation(h.db, {
      assetId: 'a1',
      libraryId: 'lib1',
      userId: 'u1',
      requestKey: 'manual:1',
      requestedFileVersion: 1,
      sourceRel: 'a1.mp4',
      now,
    }).record
    const claimed = claimNextMutation(h.db, now, { workerId: 'm1', leaseMs: 60_000 })!
    expect(
      markAssetPendingDelete(h.db, 'a1', mutation.id, 1, {
        workerId: 'm1',
        leaseEpoch: claimed.leaseEpoch,
        now,
      }),
    ).toBe(true)
    h.db
      .query<null, [string]>(`UPDATE file_mutations SET state = 'validated' WHERE id = ?`)
      .run(mutation.id)
    releaseMutationLease(h.db, mutation.id, {
      workerId: 'm1',
      leaseEpoch: claimed.leaseEpoch,
      now,
    })

    const item = claimNextBulkItem(h.db, operation.id, now)!
    attachBulkItemMutation(h.db, item.id, mutation.id, now)
    h.config.fileMutationEnabled = false

    expect(await run(h.db, h.config)).toBe(true)
    expect(getBulkOperation(h.db, operation.id)?.state).toBe('cancelled')
    expect(itemStates(h.db, operation.id)).toEqual(['cancelled'])
    const asset = h.db
      .query<{ deletedAt: number | null; pending: string | null }, []>(
        `SELECT deleted_at AS deletedAt, pending_delete_mutation_id AS pending FROM assets WHERE id = 'a1'`,
      )
      .get()!
    expect(asset).toEqual({ deletedAt: null, pending: null })
    expect(await exists(path.join(h.libraryDir, 'a1.mp4'))).toBe(true)
    h.db.close()
  })
})
