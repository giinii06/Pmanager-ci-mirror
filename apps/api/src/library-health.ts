import { readdir, stat } from 'node:fs/promises'
import { listLibraries } from '@mediavault/database'
import { isMountBoundaryRoot, type LibraryHealthDTO } from '@mediavault/shared'
import { resolveInside } from '@mediavault/media'
import type { AppContext } from './context'

/**
 * A mount boundary root with indexed assets but no visible entries is the
 * signature of a drive that dropped its mount while the directory stayed.
 */
export async function checkLibraryHealth(ctx: AppContext): Promise<LibraryHealthDTO[]> {
  const libs = listLibraries(ctx.db)
  return Promise.all(
    libs.map(async (lib) => {
      const abs = resolveInside(ctx.config.mediaRoot, lib.rootPath)
      let accessible = false
      if (abs) {
        try {
          const info = await stat(abs)
          if (info.isDirectory()) {
            if (isMountBoundaryRoot(lib.rootPath) && lib.assetCount > 0) {
              const entries = await readdir(abs)
              accessible = entries.length > 0
            } else {
              accessible = true
            }
          }
        } catch {
          accessible = false
        }
      }

      const status: LibraryHealthDTO['status'] = !accessible
        ? 'unavailable'
        : lib.lastError?.startsWith('drive_unavailable')
          ? 'blocked'
          : lib.scanState === 'scanning'
            ? 'scanning'
            : 'available'

      return {
        id: lib.id,
        name: lib.name,
        rootPath: lib.rootPath,
        status,
        scanState: lib.scanState,
        lastError: lib.lastError,
        lastScanAt: lib.lastScanAt !== null ? new Date(lib.lastScanAt).toISOString() : null,
        assetCount: lib.assetCount,
        scannedFiles: lib.scannedFiles,
      }
    }),
  )
}
