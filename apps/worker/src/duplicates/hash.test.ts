import { afterAll, describe, expect, test } from 'bun:test'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  CHUNK_BYTES,
  QUICK_CHUNKS,
  UnstableFileError,
  fullHash,
  hashFileStable,
  quickCoversWhole,
  quickHash,
  stabilityViolation,
  statSignature,
  type StatSignature,
} from './hash'

const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mv-hash-'))
  dirs.push(dir)
  return dir
}

function bytes(size: number, fill: number): Buffer {
  return Buffer.alloc(size, fill)
}

describe('content hashing', () => {
  test('the same bytes under two names hash the same, and one changed byte does not', async () => {
    const dir = await workspace()
    const first = path.join(dir, 'clip.mp4')
    const second = path.join(dir, '사본.mp4')
    const other = path.join(dir, 'other.mp4')
    await writeFile(first, bytes(4096, 7))
    await writeFile(second, bytes(4096, 7))
    await writeFile(other, bytes(4096, 8))

    expect(await fullHash(first)).toBe(await fullHash(second))
    expect(await fullHash(other)).not.toBe(await fullHash(first))
  })

  test('an empty file hashes, and two of them are one content', async () => {
    const dir = await workspace()
    const first = path.join(dir, 'empty-a.bin')
    const second = path.join(dir, 'empty-b.bin')
    await writeFile(first, '')
    await writeFile(second, '')

    const hash = await fullHash(first)
    expect(hash).toHaveLength(64)
    expect(await fullHash(second)).toBe(hash)
    expect(await quickHash(first, 0)).toEqual({ hash, whole: true })
  })

  test('a file larger than one chunk hashes every byte of it', async () => {
    const dir = await workspace()
    const size = 5 * CHUNK_BYTES + 123
    const whole = path.join(dir, 'whole.mp4')
    const nearMiss = path.join(dir, 'near-miss.mp4')
    await writeFile(whole, bytes(size, 1))
    const tail = bytes(size, 1)
    tail[tail.length - 1] = 2
    await writeFile(nearMiss, tail)

    const digest = await fullHash(whole)
    expect(digest).toHaveLength(64)
    expect(await fullHash(nearMiss)).not.toBe(digest)
  })
})

describe('quick hashing', () => {
  test('a file the quick read covers whole reports its full hash as whole', async () => {
    const dir = await workspace()
    const file = path.join(dir, 'small.mp4')
    const size = CHUNK_BYTES * QUICK_CHUNKS
    await writeFile(file, bytes(size, 3))

    expect(quickCoversWhole(size)).toBe(true)
    expect(await quickHash(file, size)).toEqual({ hash: await fullHash(file), whole: true })
  })

  test('a larger file is sampled, so its quick hash is not its full hash', async () => {
    const dir = await workspace()
    const file = path.join(dir, 'large.mp4')
    const size = CHUNK_BYTES * QUICK_CHUNKS + 1
    await writeFile(file, bytes(size, 3))

    expect(quickCoversWhole(size)).toBe(false)
    const quick = await quickHash(file, size)
    expect(quick.whole).toBe(false)
    expect(quick.hash).not.toBe(await fullHash(file))
  })

  test('a byte outside the sampled windows still separates two files', async () => {
    const dir = await workspace()
    const size = CHUNK_BYTES * QUICK_CHUNKS + 1
    const first = path.join(dir, 'first.mp4')
    const second = path.join(dir, 'second.mp4')
    await writeFile(first, bytes(size, 3))
    const changed = bytes(size, 3)
    changed[CHUNK_BYTES + 7] = 9
    await writeFile(second, changed)

    expect((await quickHash(first, size)).hash).not.toBe((await quickHash(second, size)).hash)
  })
})

describe('a hash is only recorded for a file that held still', () => {
  test('a file that grew before the read is refused', async () => {
    const dir = await workspace()
    const file = path.join(dir, 'growing.mp4')
    await writeFile(file, bytes(4096, 4))
    const before = await statSignature(file)

    await appendFile(file, bytes(16, 5))

    await expect(hashFileStable(file, before)).rejects.toThrow(UnstableFileError)
  })

  test('a file that matches its expected size and mtime is hashed and signed', async () => {
    const dir = await workspace()
    const file = path.join(dir, 'steady.mp4')
    await writeFile(file, bytes(4096, 4))
    const signature = await statSignature(file)

    const result = await hashFileStable(file, signature)
    expect(result.fullHash).toBe(await fullHash(file))
    expect(result.signature).toEqual(signature)
  })

  test('each field that can move is named', () => {
    const before: StatSignature = { size: 10, mtimeMs: 100, ino: 5, dev: 1 }
    expect(stabilityViolation(before, { ...before })).toBeNull()
    expect(stabilityViolation(before, { ...before, size: 11 })).toBe('size changed while hashing')
    expect(stabilityViolation(before, { ...before, mtimeMs: 101 })).toBe('mtime changed while hashing')
    expect(stabilityViolation(before, { ...before, ino: 6 })).toBe('inode changed while hashing')
    expect(stabilityViolation(before, { ...before, dev: 2 })).toBe('device changed while hashing')
  })

  test('an aborted signal stops the read instead of finishing it', async () => {
    const dir = await workspace()
    const file = path.join(dir, 'cancelled.mp4')
    await writeFile(file, bytes(CHUNK_BYTES * 4, 6))
    const controller = new AbortController()
    controller.abort('cancelled')

    await expect(fullHash(file, controller.signal)).rejects.toThrow('the hash was interrupted')
  })
})
