/**
 * Test fixture: runs a delete mutation step by step and SIGKILLs itself at a
 * durable boundary.
 *
 * The mutation test spawns this file to prove that a process death between the
 * quarantine rename and the final purge leaves a state the worker can resume,
 * not one it has to guess about. Everything it needs arrives through the
 * environment so the child never shares memory with the test.
 *
 * Bun commits `db.transaction()` natively, so a kill inside a transition would
 * roll it back and prove nothing. The stage checks therefore run between steps,
 * after the previous transition committed, except for `purging`: that one fires
 * on the pre-check of the `completed` transition, when the file is already
 * unlinked and nothing is pending in the open transaction.
 */
import path from 'node:path'
import { existsSync } from 'node:fs'
import { claimNextMutation, getFileMutation, openDatabase, type Db } from '@mediavault/database'
import type { WorkerConfig } from './config'
import { executeDeleteMutation, type MutationContext } from './mutations/delete'

type KillStage = 'validated' | 'quarantined' | 'db_committed' | 'purging'

const killAt = process.env.KILL_AT as KillStage | undefined
const mutationIdEnv = process.env.MUTATION_ID
const mediaRootEnv = process.env.MEDIA_ROOT
const cacheDirEnv = process.env.CACHE_DIR
const dbPathEnv = process.env.DB_PATH

if (!killAt || !mutationIdEnv || !mediaRootEnv || !cacheDirEnv || !dbPathEnv) {
  throw new Error('KILL_AT, MUTATION_ID, MEDIA_ROOT, CACHE_DIR and DB_PATH are required')
}

const mutationId: string = mutationIdEnv
const mediaRoot: string = mediaRootEnv
const cacheDir: string = cacheDirEnv
const dbPath: string = dbPathEnv

const db = openDatabase(dbPath)
const originalQuery = db.query.bind(db)

function currentState(): string | null {
  const row = originalQuery('SELECT state FROM file_mutations WHERE id = ?').get(mutationId) as {
    state: string
  } | null
  return row?.state ?? null
}

function sourceAbs(): string | null {
  const row = originalQuery(
    `SELECT l.root_path AS rootPath, a.relative_path AS rel
       FROM assets a JOIN libraries l ON l.id = a.library_id
      WHERE a.id = (SELECT asset_id FROM file_mutations WHERE id = ?)`,
  ).get(mutationId) as { rootPath: string; rel: string } | null
  return row ? path.join(mediaRoot, row.rootPath, row.rel) : null
}

function quarantineAbs(): string | null {
  const row = originalQuery(
    'SELECT quarantine_root AS root, quarantine_rel AS rel FROM file_mutations WHERE id = ?',
  ).get(mutationId) as { root: string | null; rel: string | null } | null
  if (!row?.root || !row.rel) return null
  return path.join(row.root, row.rel)
}

/** The final unlink lands before the `completed` transition opens its transaction. */
function killBeforeCompletion(): void {
  if (killAt !== 'purging') return
  if (currentState() !== 'purging') return
  const source = sourceAbs()
  const quarantine = quarantineAbs()
  if (source && existsSync(source)) return
  if (quarantine && existsSync(quarantine)) return
  process.kill(process.pid, 'SIGKILL')
}

const originalQueryFn = db.query
;(db as unknown as { query: typeof originalQueryFn }).query = ((sql: string) => {
  const statement = originalQuery(sql)
  const run = statement.run.bind(statement)
  ;(statement as unknown as { run: (...args: unknown[]) => unknown }).run = (...args: unknown[]) => {
    killBeforeCompletion()
    return run(...(args as []))
  }
  return statement
}) as typeof originalQueryFn

const config: WorkerConfig = {
  dataDir: path.dirname(dbPath),
  cacheDir,
  mediaRoot,
  hwaccel: null,
  pollMs: 0,
  once: true,
  gpuResource: 'gpu:0',
  workerId: `kill-worker-${process.pid}`,
  scanDeleteGuardRatio: 0.2,
  scanDeleteForce: false,
  asrResultDir: path.join(path.dirname(dbPath), 'asr'),
  translationResultDir: path.join(path.dirname(dbPath), 'translation'),
}

const claimed = claimNextMutation(db, Date.now(), { workerId: config.workerId, leaseMs: 60_000 })
if (!claimed || claimed.id !== mutationId) {
  throw new Error(`could not claim ${mutationId}; got ${claimed?.id ?? 'nothing'}`)
}

let record = getFileMutation(db, mutationId)!
for (let step = 0; step < 8; step += 1) {
  const ctx: MutationContext = {
    db,
    config,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    fence: { workerId: config.workerId, leaseEpoch: record.leaseEpoch, now: Date.now() },
  }
  await executeDeleteMutation(ctx, record)
  record = getFileMutation(db, mutationId)!
  if (record.state === killAt && killAt !== 'purging') process.kill(process.pid, 'SIGKILL')
  if (record.state === 'completed' || record.state === 'blocked') break
}

// Reaching this line means the kill point never fired: the stage is wrong or
// the state machine skipped it. Fail loudly instead of pretending to crash.
process.stderr.write(`kill point ${killAt} was never reached; state=${currentState()}\n`)
process.exit(3)
