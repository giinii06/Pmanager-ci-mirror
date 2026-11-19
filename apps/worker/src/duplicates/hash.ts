import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'

export const CHUNK_BYTES = 1024 * 1024
export const QUICK_CHUNKS = 3

export interface StatSignature {
  size: number
  /** Rounded the way `assets.mtime_ms` stores it, so the two can be compared. */
  mtimeMs: number
  ino: number
  dev: number
}

export class UnstableFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnstableFileError'
  }
}

export class AbortError extends Error {
  constructor() {
    super('the hash was interrupted')
    this.name = 'AbortError'
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError()
}

export async function statSignature(file: string): Promise<StatSignature> {
  const info = await stat(file)
  return {
    size: info.size,
    mtimeMs: Math.round(info.mtimeMs),
    ino: info.ino,
    dev: info.dev,
  }
}

/** Returns the first field that moved, or null when the file held still. */
export function stabilityViolation(before: StatSignature, after: StatSignature): string | null {
  if (after.size !== before.size) return 'size changed while hashing'
  if (after.mtimeMs !== before.mtimeMs) return 'mtime changed while hashing'
  if (after.ino !== before.ino) return 'inode changed while hashing'
  if (after.dev !== before.dev) return 'device changed while hashing'
  return null
}

export async function fullHash(file: string, signal?: AbortSignal): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
    for (;;) {
      throwIfAborted(signal)
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

/** A file this small is read whole by `quickHash`, so its quick hash is its full hash. */
export function quickCoversWhole(size: number): boolean {
  return size <= CHUNK_BYTES * QUICK_CHUNKS
}

/**
 * Samples the front, the middle and the end of a large file to separate two
 * files of the same size cheaply. A small file is read whole, so its quick hash
 * is already its full hash and `whole` says so; the caller then never reads it
 * twice.
 */
export async function quickHash(
  file: string,
  size: number,
  signal?: AbortSignal,
): Promise<{ hash: string; whole: boolean }> {
  if (quickCoversWhole(size)) {
    return { hash: await fullHash(file, signal), whole: true }
  }

  const offsets = [
    0,
    Math.max(0, Math.floor(size / 2) - Math.floor(CHUNK_BYTES / 2)),
    size - CHUNK_BYTES,
  ]
  const hash = createHash('sha256')
  const handle = await open(file, 'r')
  try {
    for (const offset of offsets) {
      throwIfAborted(signal)
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, offset)
      if (bytesRead !== CHUNK_BYTES) {
        throw new Error(`short read at ${offset} of ${file}: wanted ${CHUNK_BYTES}, got ${bytesRead}`)
      }
      hash.update(buffer)
    }
    return { hash: hash.digest('hex'), whole: false }
  } finally {
    await handle.close()
  }
}

/**
 * A hash is only worth recording if it describes a file that held still. The
 * stat after the read is the proof: a size, mtime, inode or device that moved
 * means the digest may cover two different files, so it is discarded rather
 * than stored.
 */
export async function hashFileStable(
  file: string,
  expected: { size: number; mtimeMs: number },
  signal?: AbortSignal,
): Promise<{ fullHash: string; signature: StatSignature }> {
  const before = await statSignature(file)
  if (before.size !== expected.size || before.mtimeMs !== expected.mtimeMs) {
    throw new UnstableFileError(`the file changed before it was hashed: ${file}`)
  }
  const digest = await fullHash(file, signal)
  const moved = stabilityViolation(before, await statSignature(file))
  if (moved) throw new UnstableFileError(`${moved}: ${file}`)
  return { fullHash: digest, signature: before }
}
