import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { InfiniteData } from '@tanstack/react-query'
import type { AssetDTO, Page } from '@mediavault/shared'
import { api } from './api'
import { useViewer } from '../store/viewer'
import { useUi } from '../store/ui'

export function useFavorite() {
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)

  return useMutation({
    mutationFn: ({ id, favorite }: { id: string; favorite: boolean }) =>
      api.setFavorite(id, favorite),
    onMutate: async ({ id, favorite }) => {
      await queryClient.cancelQueries({ queryKey: ['assets'] })
      queryClient.setQueriesData<InfiniteData<Page<AssetDTO>>>({ queryKey: ['assets'] }, (data) => {
        if (!data) return data
        return {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((item) => (item.id === id ? { ...item, favorite } : item)),
          })),
        }
      })
      useViewer.getState().setFavorite(id, favorite)
    },
    onError: () => {
      toast('즐겨찾기를 변경하지 못했습니다.', 'error')
      queryClient.invalidateQueries({ queryKey: ['assets'] })
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['stats'] })
    },
  })
}
