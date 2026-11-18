import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import type { AssetDTO, Page } from '@mediavault/shared'
import { useViewer } from '../store/viewer'

export function patchAssetInCaches(queryClient: QueryClient, updated: AssetDTO): void {
  useViewer.getState().patchAsset(updated)
  queryClient.setQueriesData<InfiniteData<Page<AssetDTO>>>(
    { queryKey: ['assets'] },
    (data) => {
      if (!data) return data
      return {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: page.items.map((item) => (item.id === updated.id ? updated : item)),
        })),
      }
    },
  )
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
