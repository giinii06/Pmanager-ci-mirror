import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import type { AssetDTO, Page } from '@mediavault/shared'
import { useViewer } from '../store/viewer'

function mapAssetsInCaches(
  queryClient: QueryClient,
  id: string,
  merge: (current: AssetDTO) => AssetDTO,
): void {
  const existing = useViewer.getState().items.find((item) => item.id === id)
  if (existing) useViewer.getState().patchAsset(merge(existing))
  queryClient.setQueriesData<InfiniteData<Page<AssetDTO>>>(
    { queryKey: ['assets'] },
    (data) => {
      if (!data) return data
      return {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: page.items.map((item) => (item.id === id ? merge(item) : item)),
        })),
      }
    },
  )
}

export function patchAssetInCaches(queryClient: QueryClient, updated: AssetDTO): void {
  mapAssetsInCaches(queryClient, updated.id, () => updated)
}

export function patchAssetCounters(
  queryClient: QueryClient,
  id: string,
  counters: { viewCount: number; watchTimeMs: number },
): void {
  mapAssetsInCaches(queryClient, id, (current) => ({
    ...current,
    viewCount: counters.viewCount,
    watchTimeMs: counters.watchTimeMs,
  }))
}

export function invalidateVoteCaches(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: ['stats', 'votes-activity'] })
  queryClient.invalidateQueries({ queryKey: ['folders'] })
}

export function removeAssetFromCaches(queryClient: QueryClient, id: string): void {
  useViewer.getState().removeAsset(id)
  queryClient.setQueriesData<InfiniteData<Page<AssetDTO>>>(
    { queryKey: ['assets'] },
    (data) => {
      if (!data) return data
      return {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          total: Math.max(0, page.total - (page.items.some((item) => item.id === id) ? 1 : 0)),
          items: page.items.filter((item) => item.id !== id),
        })),
      }
    },
  )
  queryClient.invalidateQueries({ queryKey: ['tags'] })
  queryClient.invalidateQueries({ queryKey: ['stats'] })
  queryClient.invalidateQueries({ queryKey: ['folders'] })
  queryClient.invalidateQueries({ queryKey: ['related'] })
}
