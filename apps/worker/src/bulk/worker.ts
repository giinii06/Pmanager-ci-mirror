import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import {
  DEFAULT_BULK_LEASE_MS,
  addTagToAsset,
  attachBulkItemMutation,
  bumpPosterVersion,
  cancelMutationPreCommit,
  cancelPendingBulkItems,
  claimNextBulkItem,
  claimNextBulkOperation,
  createAsrJob,
  createCopyMutation,
  createDeleteMutation,
  createEmbeddingJob,
  createMoveMutation,
  createSceneJob,
  createTranslationJob,
  currentTranscript,
  enqueueJob,
  finishBulkItem,
  getAssetFileInfo,
  getBulkOperation,
  getBulkOperationCounts,
  getFileMutation,
  getMutationAsset,
  getTag,
  heartbeatBulkOperation,
  listRunningBulkItems,
  releaseBulkLease,
  removeTagFromAsset,
  resetInlineRunningItems,
  transitionBulkOperation,
  type BulkOperationItemRecord,
  type BulkOperationRecord,
  type Db,
  type FileMutationRecord,
} from '@mediavault/database'
import { PRIORITY, newId } from '@mediavault/shared'
import type { WorkerConfig } from '../config'
import type { MutationLogger } from '../mutations/delete'

interface BulkContext {
  db: Db
  config: WorkerConfig
  logger: MutationLogger
  signal: AbortSignal
  fence: { workerId: string; leaseEpoch: number; now: number }
  leaseLost: boolean
}

interface ReanalyzeModels {
  asr: {
    modelRevision: string
    alignerRevision: string
    pipelineVersion: string
    retryDelayMs?: number
  }
  scene: {
    modelId: string
    modelRevision: string
    modelSha256: string
    pipelineVersion: string
    dimensions: number
    windowMs: number
    overlapMs: number
  }
  embedding: {
    modelId: string
    modelRevision: string
    modelSha256: string
    pipelineVersion: string
    dimensions: number
  }
  translation: {
    modelId: string
    modelRevision: string
    modelSha256: string
    promptVersion: string
    pipelineVersion: string
    targetLanguage: string
  }
}

interface OperationParams {
  tagId?: string
  targetLibraryId?: string
  targetFolder?: string
  stages?: string[]
  confirm?: string
  models?: ReanalyzeModels
}

type ItemOutcome =
  | { state: 'succeeded' }
  | { state: 'aborted' }
  | { state: 'failed' | 'held' | 'cancelled'; code: string; message: string }

function readParams(operation: BulkOperationRecord): OperationParams {
  try {
    return JSON.parse(operation.paramsJson) as OperationParams
  } catch {
    return {}
  }
}

function joinTarget(folder: string, filename: string): string {
  return folder === '' ? filename : `${folder}/${filename}`
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

async function writeExport(
  config: WorkerConfig,
  operation: BulkOperationRecord,
  items: BulkOperationItemRecord[],
): Promise<void> {
  const dir = path.join(config.dataDir, 'exports')
  await mkdir(dir, { recursive: true })
  const lines = ['asset_id,filename,relative_path,size_bytes,state']
  for (const item of items) {
    lines.push(
      [
        csvCell(item.assetId),
        csvCell(item.filename),
        csvCell(item.relativePath),
        csvCell(item.sizeBytes),
        csvCell(item.state),
      ].join(','),
    )
  }
  await writeFile(path.join(dir, `${operation.id}.csv`), `\uFEFF${lines.join('\n')}\n`, 'utf8')
}

async function runExport(ctx: BulkContext, operation: BulkOperationRecord): Promise<void> {
  // The export has no per-item work: every frozen row is in the file, so the
  // rows are settled first and the CSV is written from their final state.
  for (const item of listRunningBulkItems(ctx.db, operation.id)) {
    finishBulkItem(ctx.db, item.id, 'succeeded', null, ctx.fence.now)
  }
  ctx.db
    .query<null, [number, string]>(
      `UPDATE bulk_operation_items SET state = 'succeeded', updated_at = ?
       WHERE operation_id = ? AND state = 'pending'`,
    )
    .run(ctx.fence.now, operation.id)

  const items = ctx.db
    .query<BulkOperationItemRecord, [string]>(
      `SELECT id, operation_id AS operationId, asset_id AS assetId, position, filename,
              relative_path AS relativePath, size_bytes AS sizeBytes, state,
              mutation_id AS mutationId, error_code AS errorCode, error_message AS errorMessage,
              attempts, updated_at AS updatedAt
       FROM bulk_operation_items WHERE operation_id = ? ORDER BY position`,
    )
    .all(operation.id)
  await writeExport(ctx.config, operation, items)
}

function tagOutcome(
  ctx: BulkContext,
  operation: BulkOperationRecord,
  item: BulkOperationItemRecord,
  params: OperationParams,
): ItemOutcome {
  if (!params.tagId) return { state: 'held', code: 'tag_missing', message: 'The tag no longer exists.' }
  const tag = getTag(ctx.db, params.tagId)
  if (!tag) return { state: 'held', code: 'tag_missing', message: 'The tag no longer exists.' }
  const asset = getAssetFileInfo(ctx.db, item.assetId)
  if (!asset || asset.deletedAt !== null) {
    return { state: 'held', code: 'asset_missing', message: 'The file is no longer available.' }
  }
  if (operation.kind === 'tag_add') addTagToAsset(ctx.db, item.assetId, tag.id, ctx.fence.now)
  else removeTagFromAsset(ctx.db, item.assetId, tag.id)
  return { state: 'succeeded' }
}

function posterOutcome(ctx: BulkContext, item: BulkOperationItemRecord): ItemOutcome {
  const asset = getAssetFileInfo(ctx.db, item.assetId)
  if (!asset || asset.deletedAt !== null) {
    return { state: 'held', code: 'asset_missing', message: 'The file is no longer available.' }
  }
  if (!bumpPosterVersion(ctx.db, asset.id, asset.fileVersion)) {
    return { state: 'held', code: 'file_changed', message: 'The file changed while it was queued.' }
  }
  enqueueJob(
    ctx.db,
    {
      dedupeKey: `poster:${asset.id}:${asset.fileVersion}:${item.id}`,
      kind: 'thumbnail',
      priority: PRIORITY.visible,
      assetId: asset.id,
    },
    ctx.fence.now,
  )
  return { state: 'succeeded' }
}

function reanalyzeOutcome(
  ctx: BulkContext,
  item: BulkOperationItemRecord,
  params: OperationParams,
): ItemOutcome {
  const asset = getAssetFileInfo(ctx.db, item.assetId)
  if (!asset || asset.deletedAt !== null) {
    return { state: 'held', code: 'asset_missing', message: 'The file is no longer available.' }
  }
  const models = params.models
  if (!models) return { state: 'held', code: 'params_invalid', message: 'The model config is missing.' }
  const stages = new Set(params.stages ?? ['transcript', 'scenes', 'embedding'])
  const now = ctx.fence.now
  const isVideo = asset.kind === 'video'

  if (stages.has('transcript') && isVideo) {
    createAsrJob(
      ctx.db,
      {
        id: newId(16),
        assetId: asset.id,
        fileVersion: asset.fileVersion,
        modelRevision: models.asr.modelRevision,
        alignerRevision: models.asr.alignerRevision,
        pipelineVersion: models.asr.pipelineVersion,
        retryDelayMs: models.asr.retryDelayMs,
      },
      now,
    )
  }
  if (stages.has('scenes') && isVideo) {
    createSceneJob(
      ctx.db,
      {
        id: newId(16),
        assetId: asset.id,
        fileVersion: asset.fileVersion,
        modelId: models.scene.modelId,
        modelRevision: models.scene.modelRevision,
        modelSha256: models.scene.modelSha256,
        pipelineVersion: models.scene.pipelineVersion,
        dimensions: models.scene.dimensions,
        windowMs: models.scene.windowMs,
        overlapMs: models.scene.overlapMs,
        force: true,
      },
      now,
    )
  }

  const transcript = currentTranscript(ctx.db, asset.id, asset.fileVersion)
  if (stages.has('translation') && transcript) {
    createTranslationJob(
      ctx.db,
      {
        id: newId(16),
        sourceTranscriptId: transcript.id,
        assetId: asset.id,
        fileVersion: asset.fileVersion,
        sourceLanguage: transcript.language,
        targetLanguage: models.translation.targetLanguage,
        modelId: models.translation.modelId,
        modelRevision: models.translation.modelRevision,
        modelSha256: models.translation.modelSha256,
        promptVersion: models.translation.promptVersion,
        pipelineVersion: models.translation.pipelineVersion,
      },
      now,
    )
  }
  if (stages.has('embedding') && transcript) {
    createEmbeddingJob(
      ctx.db,
      {
        id: newId(16),
        assetId: asset.id,
        fileVersion: asset.fileVersion,
        sourceTranscriptId: transcript.id,
        modelId: models.embedding.modelId,
        modelRevision: models.embedding.modelRevision,
        modelSha256: models.embedding.modelSha256,
        pipelineVersion: models.embedding.pipelineVersion,
        dimensions: models.embedding.dimensions,
        force: true,
      },
      now,
    )
  }
  return { state: 'succeeded' }
}

function startFileMutation(
  ctx: BulkContext,
  operation: BulkOperationRecord,
  item: BulkOperationItemRecord,
  params: OperationParams,
): { mutationId: string } | ItemOutcome {
  const asset = getMutationAsset(ctx.db, item.assetId)
  if (!asset || asset.deletedAt !== null) {
    return { state: 'held', code: 'asset_missing', message: 'The file is no longer available.' }
  }
  const requestKey = `bulk:${operation.id}:${item.id}`
  const base = {
    assetId: asset.id,
    libraryId: asset.libraryId,
    userId: operation.userId,
    requestKey,
    requestedFileVersion: asset.fileVersion,
    sourceRel: asset.relativePath,
    now: ctx.fence.now,
  }
  if (operation.kind === 'delete') {
    return { mutationId: createDeleteMutation(ctx.db, base).record.id }
  }
  if (!params.targetLibraryId || params.targetFolder === undefined) {
    return { state: 'held', code: 'target_missing', message: 'The target folder is missing.' }
  }
  const targetRel = joinTarget(params.targetFolder, asset.filename)
  if (operation.kind === 'move') {
    return {
      mutationId: createMoveMutation(ctx.db, {
        ...base,
        targetLibraryId: params.targetLibraryId,
        targetRel,
      }).record.id,
    }
  }
  return {
    mutationId: createCopyMutation(ctx.db, {
      ...base,
      targetLibraryId: params.targetLibraryId,
      targetRel,
    }).record.id,
  }
}

async function waitForMutation(
  ctx: BulkContext,
  operation: BulkOperationRecord,
  mutationId: string,
): Promise<ItemOutcome> {
  const pollMs = ctx.config.mutationPollMs ?? 1_000
  while (!ctx.signal.aborted && !ctx.leaseLost) {
    const mutation: FileMutationRecord | null = getFileMutation(ctx.db, mutationId)
    if (!mutation) {
      return { state: 'failed', code: 'mutation_missing', message: 'The file operation disappeared.' }
    }
    if (mutation.state === 'completed') return { state: 'succeeded' }
    if (mutation.state === 'blocked') {
      return {
        state: 'held',
        code: mutation.errorCode ?? 'operation_blocked',
        message: mutation.errorMessage ?? 'The file operation was blocked.',
      }
    }
    if (mutation.state === 'cancelled_pre_commit') {
      return {
        state: 'cancelled',
        code: 'cancelled_by_user',
        message: 'The operation was cancelled before it touched the file.',
      }
    }
    if (mutation.state === 'failed_retryable' && mutation.attempts >= mutation.maxAttempts) {
      return {
        state: 'held',
        code: mutation.errorCode ?? 'retry_exhausted',
        message: mutation.errorMessage ?? 'The file operation ran out of retries.',
      }
    }

    const fresh = getBulkOperation(ctx.db, operation.id)
    if (fresh?.state === 'cancelling') {
      cancelMutationPreCommit(ctx.db, mutationId, ctx.fence.now)
    }
    await Bun.sleep(pollMs)
  }
  return { state: 'aborted' }
}

async function runFileItem(
  ctx: BulkContext,
  operation: BulkOperationRecord,
  item: BulkOperationItemRecord,
  params: OperationParams,
): Promise<ItemOutcome> {
  const started = startFileMutation(ctx, operation, item, params)
  if ('state' in started) return started
  attachBulkItemMutation(ctx.db, item.id, started.mutationId, ctx.fence.now)
  return waitForMutation(ctx, operation, started.mutationId)
}

async function runItem(
  ctx: BulkContext,
  operation: BulkOperationRecord,
  item: BulkOperationItemRecord,
  params: OperationParams,
): Promise<ItemOutcome> {
  try {
    switch (operation.kind) {
      case 'tag_add':
      case 'tag_remove':
        return tagOutcome(ctx, operation, item, params)
      case 'poster':
        return posterOutcome(ctx, item)
      case 'reanalyze':
        return reanalyzeOutcome(ctx, item, params)
      case 'delete':
      case 'move':
      case 'copy':
        return await runFileItem(ctx, operation, item, params)
      default:
        return { state: 'held', code: 'unsupported_kind', message: 'Unsupported operation kind.' }
    }
  } catch (error) {
    return { state: 'failed', code: 'item_failed', message: (error as Error).message }
  }
}

async function finalize(ctx: BulkContext, operation: BulkOperationRecord): Promise<void> {
  const counts = getBulkOperationCounts(ctx.db, operation.id)
  const fresh = getBulkOperation(ctx.db, operation.id)
  if (!fresh) return
  if (fresh.state === 'cancelling') {
    transitionBulkOperation(ctx.db, operation.id, ctx.fence, {
      state: 'cancelled',
      completedAt: ctx.fence.now,
    })
    return
  }
  const state =
    counts.failed + counts.held > 0 ? 'completed_with_errors' : 'completed'
  transitionBulkOperation(ctx.db, operation.id, ctx.fence, {
    state,
    completedAt: ctx.fence.now,
  })
}

async function failOperation(
  ctx: BulkContext,
  operation: BulkOperationRecord,
  error: unknown,
): Promise<void> {
  const message = (error as Error).message
  if (operation.attempts < operation.maxAttempts) {
    const backoff = Math.min(10 * 60_000, 30_000 * 2 ** Math.max(0, operation.attempts - 1))
    transitionBulkOperation(ctx.db, operation.id, ctx.fence, {
      state: 'queued',
      errorCode: 'bulk_failed',
      errorMessage: message.slice(0, 500),
      retryAfter: ctx.fence.now + backoff,
    })
    ctx.logger.warn('bulk.retry', { operationId: operation.id, message })
    return
  }
  transitionBulkOperation(ctx.db, operation.id, ctx.fence, {
    state: 'failed',
    errorCode: 'retry_exhausted',
    errorMessage: message.slice(0, 500),
  })
  ctx.logger.warn('bulk.failed', { operationId: operation.id, message })
}

async function runOperation(
  ctx: BulkContext,
  operation: BulkOperationRecord,
): Promise<void> {
  const params = readParams(operation)
  resetInlineRunningItems(ctx.db, operation.id, ctx.fence.now)

  if (operation.kind === 'export') {
    await runExport(ctx, operation)
    await finalize(ctx, operation)
    return
  }

  while (!ctx.signal.aborted && !ctx.leaseLost) {
    const fresh = getBulkOperation(ctx.db, operation.id)
    if (!fresh) return

    // Reconcile any item left running by a previous worker.
    for (const item of listRunningBulkItems(ctx.db, operation.id)) {
      if (!item.mutationId) continue
      const mutation = getFileMutation(ctx.db, item.mutationId)
      if (!mutation) {
        finishBulkItem(ctx.db, item.id, 'failed', {
          code: 'mutation_missing',
          message: 'The file operation disappeared.',
        }, ctx.fence.now)
        continue
      }
      if (mutation.state === 'completed') {
        finishBulkItem(ctx.db, item.id, 'succeeded', null, ctx.fence.now)
      } else if (mutation.state === 'blocked') {
        finishBulkItem(ctx.db, item.id, 'held', {
          code: mutation.errorCode ?? 'operation_blocked',
          message: mutation.errorMessage ?? 'The file operation was blocked.',
        }, ctx.fence.now)
      } else if (mutation.state === 'cancelled_pre_commit') {
        finishBulkItem(ctx.db, item.id, 'cancelled', {
          code: 'cancelled_by_user',
          message: 'The operation was cancelled before it touched the file.',
        }, ctx.fence.now)
      } else if (
        mutation.state === 'failed_retryable' &&
        mutation.attempts >= mutation.maxAttempts
      ) {
        finishBulkItem(ctx.db, item.id, 'held', {
          code: mutation.errorCode ?? 'retry_exhausted',
          message: mutation.errorMessage ?? 'The file operation ran out of retries.',
        }, ctx.fence.now)
      } else if (!ctx.config.fileMutationEnabled) {
        // The engine was turned off across the restart, so no worker will ever
        // finish this mutation. The operation stops as cancelled; a mutation
        // past validation has an uncertain file state, so its item is held.
        transitionBulkOperation(ctx.db, operation.id, ctx.fence, { state: 'cancelling' })
        if (cancelMutationPreCommit(ctx.db, item.mutationId, ctx.fence.now)) {
          finishBulkItem(ctx.db, item.id, 'cancelled', {
            code: 'mutation_engine_disabled',
            message: 'The file engine was turned off before this file was touched.',
          }, ctx.fence.now)
        } else {
          finishBulkItem(ctx.db, item.id, 'held', {
            code: 'mutation_engine_disabled',
            message: 'The file engine is off and this file operation did not finish.',
          }, ctx.fence.now)
        }
      }
    }

    if (fresh.state === 'cancelling') {
      cancelPendingBulkItems(ctx.db, operation.id, ctx.fence.now)
      for (const item of listRunningBulkItems(ctx.db, operation.id)) {
        if (!item.mutationId) continue
        if (cancelMutationPreCommit(ctx.db, item.mutationId, ctx.fence.now)) {
          finishBulkItem(ctx.db, item.id, 'cancelled', {
            code: 'cancelled_by_user',
            message: 'The operation was cancelled before it touched the file.',
          }, ctx.fence.now)
        }
      }
    }

    const counts = getBulkOperationCounts(ctx.db, operation.id)
    if (counts.pending === 0 && counts.running === 0) {
      await finalize(ctx, operation)
      return
    }

    const item = claimNextBulkItem(ctx.db, operation.id, ctx.fence.now)
    if (!item) {
      if (counts.running > 0) {
        await Bun.sleep(ctx.config.bulkPollMs ?? 1_000)
        continue
      }
      await finalize(ctx, operation)
      return
    }

    if (fresh.state === 'cancelling') {
      finishBulkItem(ctx.db, item.id, 'cancelled', {
        code: 'cancelled_by_user',
        message: 'The operation was cancelled before this file was started.',
      }, ctx.fence.now)
      continue
    }

    const outcome = await runItem(ctx, operation, item, params)
    if (outcome.state === 'aborted') return
    finishBulkItem(
      ctx.db,
      item.id,
      outcome.state,
      outcome.state === 'succeeded' ? null : { code: outcome.code, message: outcome.message },
      ctx.fence.now,
    )
  }
}

/**
 * Claims and drains one operation, then returns. The loop calls this until it
 * reports no work, which keeps a single operation's lifetime testable without
 * a timer.
 */
export async function runBulkOperationOnce(
  db: Db,
  config: WorkerConfig,
  logger: MutationLogger,
  signal: AbortSignal,
): Promise<boolean> {
  const workerId = `${config.workerId}:bulk`
  const leaseMs = DEFAULT_BULK_LEASE_MS
  const operation = claimNextBulkOperation(db, Date.now(), { workerId, leaseMs })
  if (!operation) return false

  const fence = { workerId, leaseEpoch: operation.leaseEpoch, now: Date.now() }
  const ctx: BulkContext = {
    db,
    config,
    logger,
    signal,
    fence,
    leaseLost: false,
  }
  const timer = setInterval(() => {
    fence.now = Date.now()
    if (!heartbeatBulkOperation(db, operation.id, fence, leaseMs)) ctx.leaseLost = true
  }, Math.floor(leaseMs / 3))

  try {
    await runOperation(ctx, operation)
  } catch (error) {
    await failOperation(ctx, operation, error)
  } finally {
    clearInterval(timer)
    fence.now = Date.now()
    releaseBulkLease(db, operation.id, fence)
  }
  return true
}

/**
 * Runs beside the mutation loop. One operation is claimed at a time; each item
 * commits its own state, so a kill loses at most the item in flight, and the
 * resume path reconciles a running item against the file mutation it started.
 */
export async function runBulkLoop(
  db: Db,
  config: WorkerConfig,
  logger: MutationLogger,
  signal: AbortSignal,
): Promise<void> {
  if (!config.bulkOperationsEnabled) return

  while (!signal.aborted) {
    const worked = await runBulkOperationOnce(db, config, logger, signal)
    if (!worked) await Bun.sleep(config.bulkPollMs ?? 1_000)
  }
}
