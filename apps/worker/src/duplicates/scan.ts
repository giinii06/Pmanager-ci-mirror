import { realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  duplicateCandidates,
  exactDuplicateGroups,
  getFileFingerprint,
  replaceDuplicateGroups,
  upsertFileFingerprint,
  type Db,
  type DuplicateCandidate,
} from '@mediavault/database'
import { resolveInside } from '@mediavault/media'
import type { WorkerConfig } from '../config'
import { ScanInterruptedError, interruptionReason } from '../scan'
import {
  AbortError,
  UnstableFileError,
  hashFileStable,
  quickCoversWhole,
  quickHash,
  statSignature,
  type StatSignature,
} from './hash'

export interface DuplicateScanSummary {
  candidates: number
  /** Candidates whose file exists, sits inside its root, and still matches its row. */
  scanned: number
  hashed: number
  reused: number
  missing: number
  changed: number
  /** A path that resolves outside its library root, including through a symlink. */
  refused: number
  skipped: number
  groups: number
  members: number
  hardlinked: number
  durationMs: number
}

export interface DuplicateScanOptions {
  libraryId?: string
  signal?: AbortSignal
  now?: number
}

interface Pending {
  assetId: string
  fileVersion: number
  sizeBytes: number
  file: string
  signature: StatSignature
  quickHash: string
  /** A full hash already stored for this version and signature, so no read is owed. */
  knownFullHash: string | null
  /** The quick hash came from the store rather than from this scan. */
  fromStore: boolean
}

/**
 * Reads bytes and writes fingerprints. It opens nothing for writing and it
 * cannot delete: the only rows it touches are `file_fingerprints` and the
 * duplicate groups, which exist to be reviewed.
 */
export async function scanDuplicates(
  db: Db,
  config: WorkerConfig,
  options: DuplicateScanOptions = {},
): Promise<DuplicateScanSummary> {
  const startedAt = options.now ?? Date.now()
  const signal = options.signal
  const interruption = () =>
    new ScanInterruptedError(signal ? interruptionReason(signal) : 'shutdown')
  const summary: DuplicateScanSummary = {
    candidates: 0,
    scanned: 0,
    hashed: 0,
    reused: 0,
    missing: 0,
    changed: 0,
    refused: 0,
    skipped: 0,
    groups: 0,
    members: 0,
    hardlinked: 0,
    durationMs: 0,
  }

  const candidates = duplicateCandidates(db, options.libraryId)
  summary.candidates = candidates.length

  const realRoots = new Map<string, string | null>()
  const realRoot = async (root: string): Promise<string | null> => {
    const known = realRoots.get(root)
    if (known !== undefined) return known
    try {
      const resolved = await realpath(root)
      realRoots.set(root, resolved)
      return resolved
    } catch {
      realRoots.set(root, null)
      return null
    }
  }

  /** `resolveInside` is string arithmetic; a symlink is the case it cannot see. */
  const escapes = (root: string, real: string): boolean => {
    const relative = path.relative(root, real)
    return relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))
  }

  const pending: Pending[] = []

  /** The reason a candidate produced no hash; each name is also a summary counter. */
  const inspect = async (
    candidate: DuplicateCandidate,
  ): Promise<
    | { state: 'ok'; file: string; signature: StatSignature }
    | { state: 'missing' | 'changed' | 'refused' }
  > => {
    const root = resolveInside(config.mediaRoot, candidate.rootPath)
    const file = root ? resolveInside(root, candidate.relativePath) : null
    if (!root || !file) return { state: 'refused' }

    const libraryRoot = await realRoot(root)
    if (!libraryRoot) return { state: 'missing' }
    try {
      if (escapes(libraryRoot, await realpath(file))) return { state: 'refused' }
      const signature = await statSignature(file)
      if (signature.size !== candidate.sizeBytes || signature.mtimeMs !== candidate.mtimeMs) {
        return { state: 'changed' }
      }
      return { state: 'ok', file, signature }
    } catch {
      return { state: 'missing' }
    }
  }

  for (const candidate of candidates) {
    if (signal?.aborted) throw interruption()

    const inspected = await inspect(candidate)
    if (inspected.state !== 'ok') {
      summary[inspected.state] += 1
      continue
    }
    const { file, signature } = inspected
    summary.scanned += 1

    const entry = {
      assetId: candidate.id,
      fileVersion: candidate.fileVersion,
      sizeBytes: candidate.sizeBytes,
      file,
      signature,
    }

    // The scanner bumps `file_version` on any change, so a stored row for this
    // version describes this body of bytes; a file that moved is caught above.
    const stored = getFileFingerprint(db, candidate.id, candidate.fileVersion)
    if (
      stored &&
      stored.quickHash !== null &&
      stored.sizeBytes === candidate.sizeBytes &&
      stored.deviceId === signature.dev &&
      stored.inode === signature.ino
    ) {
      summary.reused += 1
      pending.push({
        ...entry,
        quickHash: stored.quickHash,
        knownFullHash: stored.fullHash,
        fromStore: true,
      })
      continue
    }

    try {
      const quick = await quickHash(file, candidate.sizeBytes, signal)
      pending.push({ ...entry, quickHash: quick.hash, knownFullHash: null, fromStore: false })
    } catch (error) {
      if (error instanceof AbortError) throw interruption()
      summary.skipped += 1
    }
  }

  const buckets = new Map<string, Pending[]>()
  for (const entry of pending) {
    const key = `${entry.sizeBytes}:${entry.quickHash}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(entry)
    else buckets.set(key, [entry])
  }

  for (const bucket of buckets.values()) {
    const shared = bucket.length > 1
    for (const entry of bucket) {
      if (signal?.aborted) throw interruption()
      if (entry.knownFullHash !== null) continue
      try {
        const full = quickCoversWhole(entry.sizeBytes)
          ? entry.quickHash
          : shared
            ? (await hashFileStable(entry.file, entry.signature, signal)).fullHash
            : null
        // A stored quick hash with no full hash is already the whole row.
        if (entry.fromStore && full === null) continue
        upsertFileFingerprint(
          db,
          {
            assetId: entry.assetId,
            fileVersion: entry.fileVersion,
            sizeBytes: entry.sizeBytes,
            quickHash: entry.quickHash,
            fullHash: full,
            deviceId: entry.signature.dev,
            inode: entry.signature.ino,
          },
          Date.now(),
        )
        summary.hashed += 1
      } catch (error) {
        if (error instanceof AbortError) throw interruption()
        // The file moved under the read; its row is stale until the next scan.
        if (error instanceof UnstableFileError) summary.changed += 1
        else summary.skipped += 1
      }
    }
  }

  const groups = exactDuplicateGroups(db)
  replaceDuplicateGroups(db, 'exact', groups, Date.now())

  summary.groups = groups.length
  summary.members = groups.reduce((total, group) => total + group.members.length, 0)
  summary.hardlinked = groups.reduce(
    (total, group) => total + group.members.filter((member) => member.sameInode).length,
    0,
  )
  summary.durationMs = Date.now() - startedAt
  return summary
}
