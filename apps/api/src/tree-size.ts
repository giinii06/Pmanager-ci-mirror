import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

export interface TreeSize {
  bytes: number
  files: number
}

const STAT_BATCH = 64

/** Total bytes and file count under a root; a missing root is zero, not an error. */
export async function measureTree(root: string): Promise<TreeSize> {
  const total: TreeSize = { bytes: 0, files: 0 }

  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const files: string[] = []
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
        continue
      }
      if (entry.isFile()) files.push(abs)
    }
    for (let index = 0; index < files.length; index += STAT_BATCH) {
      await Promise.all(
        files.slice(index, index + STAT_BATCH).map(async (abs) => {
          try {
            total.bytes += (await stat(abs)).size
            total.files += 1
          } catch {
            // Vanished mid-walk.
          }
        }),
      )
    }
  }

  await walk(root)
  return total
}
