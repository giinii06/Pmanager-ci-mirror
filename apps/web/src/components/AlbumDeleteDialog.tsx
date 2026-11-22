import { useEffect, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { FolderDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { randomToken } from '../lib/random'
import { useUi } from '../store/ui'

type AlbumStatus = Awaited<ReturnType<typeof api.albumDeleteStatus>>

async function monitorAlbumDelete(
  fetchStatus: () => Promise<AlbumStatus>,
): Promise<'completed' | 'failed' | 'unresolved'> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 5_000))
    try {
      const status = await fetchStatus()
      if (status.state === 'failed') return 'failed'
      if (status.state === 'completed') return 'completed'
    } catch {
      // A temporary network failure does not cancel the durable server queue.
    }
  }
  return 'unresolved'
}

export function AlbumDeleteDialog({
  folder,
  onClose,
  onAccepted,
}: {
  folder: FolderDTO | null
  onClose: () => void
  onAccepted?: (folderId: string) => void
}) {
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const requestKeys = useRef(new Map<string, string>())
  const startedFor = useRef<string | null>(null)
  const deletion = useMutation({
    mutationFn: (selected: FolderDTO) => {
      const key = requestKeys.current.get(selected.id) ?? randomToken()
      requestKeys.current.set(selected.id, key)
      return api.deleteAlbum(selected.id, key)
    },
    onMutate: async (selected) => {
      await queryClient.cancelQueries({ queryKey: ['folders'] })
      const snapshots = queryClient.getQueriesData<FolderDTO[]>({ queryKey: ['folders'] })
      queryClient.setQueriesData<FolderDTO[]>({ queryKey: ['folders'] },
        (list) => list?.filter((item) => item.id !== selected.id))
      return { snapshots }
    },
    onSuccess: (batch, selected) => {
      requestKeys.current.delete(selected.id)
      onClose()
      onAccepted?.(selected.id)
      toast(`'${selected.name}' 앨범을 목록에서 숨겼습니다. 사진 ${batch.total}장은 백그라운드에서 순차 삭제됩니다.`, 'success')
      void queryClient.invalidateQueries({ queryKey: ['folders'] })
      void monitorAlbumDelete(() => api.albumDeleteStatus(batch.id)).then((outcome) => {
        if (outcome === 'failed') {
          toast('앨범 사진 일부를 삭제하지 못했습니다. 남은 사진을 확인해 주세요.', 'error')
          void queryClient.invalidateQueries({ queryKey: ['folders'] })
          void queryClient.invalidateQueries({ queryKey: ['assets'] })
          void queryClient.invalidateQueries({ queryKey: ['stats'] })
        } else if (outcome === 'completed') {
          void queryClient.invalidateQueries({ queryKey: ['stats'] })
          void queryClient.invalidateQueries({ queryKey: ['tags'] })
        }
      })
    },
    onError: (error, selected, context) => {
      for (const [key, data] of context?.snapshots ?? []) {
        queryClient.setQueryData(key, data)
      }
      onClose()
      toast(error instanceof Error ? error.message : `'${selected.name}' 앨범 삭제를 접수하지 못했습니다.`, 'error')
    },
  })

  useEffect(() => {
    if (!folder) {
      startedFor.current = null
      return
    }
    if (startedFor.current === folder.id) return
    startedFor.current = folder.id
    deletion.mutate(folder)
  }, [folder, deletion.mutate])

  // The caller selects the album on the first click; the deletion is enqueued immediately.
  return null
}
