import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock, ListVideo, Plus } from 'lucide-react'
import type { AssetDTO, PlaylistDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { formatCount } from '../lib/format'
import { useUi } from '../store/ui'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import { Input } from './ui/Input'
import { Spinner } from './ui/Spinner'

export function AddToPlaylistDialog({
  open,
  onClose,
  asset,
}: {
  open: boolean
  onClose: () => void
  asset: AssetDTO
}) {
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const [name, setName] = useState('')

  const playlists = useQuery({
    queryKey: ['playlists'],
    queryFn: api.playlistsWithWatchLater,
    enabled: open,
  })

  const invalidate = (playlistId: string) => {
    queryClient.invalidateQueries({ queryKey: ['playlists'] })
    queryClient.invalidateQueries({ queryKey: ['playlist', playlistId] })
  }

  const add = useMutation({
    mutationFn: (playlist: PlaylistDTO) =>
      playlist.kind === 'watch_later'
        ? api.addWatchLater(asset.id)
        : api.addPlaylistItem(playlist.id, asset.id),
    onSuccess: (result) => {
      invalidate(result.playlist.id)
      toast(`'${result.playlist.name}'에 담았습니다.`, 'success')
      onClose()
    },
    onError: (error) =>
      toast(error instanceof Error ? error.message : '재생목록에 담지 못했습니다.', 'error'),
  })

  const create = useMutation({
    mutationFn: async () => {
      const playlist = await api.createPlaylist({ name: name.trim() })
      await api.addPlaylistItem(playlist.id, asset.id)
      return playlist
    },
    onSuccess: (playlist) => {
      invalidate(playlist.id)
      setName('')
      toast(`'${playlist.name}'을 만들어 담았습니다.`, 'success')
      onClose()
    },
    onError: (error) =>
      toast(
        error instanceof Error ? error.message : '재생목록을 만들고 담지 못했습니다.',
        'error',
      ),
  })

  const list = playlists.data?.playlists ?? []
  const busy = add.isPending || create.isPending

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="재생목록에 담기"
      description={asset.filename}
      footer={<Button onClick={onClose}>닫기</Button>}
    >
      <div className="space-y-3">
        {playlists.isPending ? (
          <div className="flex items-center justify-center gap-2 py-6 text-[12.5px] text-muted">
            <Spinner />
            불러오는 중
          </div>
        ) : (
          <ul className="space-y-1">
            {list.map((playlist) => (
              <li key={playlist.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => add.mutate(playlist)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg border border-line bg-panel-2 px-3 py-2 text-left transition-colors',
                    'hover:border-line-strong hover:bg-raised disabled:opacity-50',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                      playlist.kind === 'watch_later'
                        ? 'bg-accent/15 text-accent'
                        : 'bg-panel text-faint',
                    )}
                  >
                    {playlist.kind === 'watch_later' ? <Clock size={13} /> : <ListVideo size={13} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-ink">
                      {playlist.name}
                    </span>
                    <span className="block text-[11px] text-faint">
                      {formatCount(playlist.itemCount)}개
                    </span>
                  </span>
                  <Plus size={13} className="shrink-0 text-faint" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <form
          className="flex items-center gap-1.5 border-t border-line pt-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim()) create.mutate()
          }}
        >
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="새 재생목록 이름"
            maxLength={80}
            className="h-8"
          />
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={!name.trim() || busy}
            className="shrink-0"
          >
            <Plus size={12} />
            만들고 담기
          </Button>
        </form>
      </div>
    </Dialog>
  )
}
