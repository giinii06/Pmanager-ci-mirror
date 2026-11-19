import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Clock,
  GripVertical,
  ListVideo,
  Play,
  Plus,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import type { PlaylistDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { formatAgo, formatCount, formatDuration } from '../lib/format'
import { useUi } from '../store/ui'
import { useViewer } from '../store/viewer'
import { EmptyState } from '../components/EmptyState'
import { PageHeading } from '../components/PageHeading'
import { Thumb } from '../components/Thumb'
import { Button } from '../components/ui/Button'
import { Dialog } from '../components/ui/Dialog'
import { Input } from '../components/ui/Input'
import { LoadingBlock } from '../components/ui/Spinner'

const WATCH_LATER_HINT = '나중에 볼 영상을 모아 두는 기본 목록입니다.'

export function PlaylistsPage() {
  const [creating, setCreating] = useState(false)
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const playlists = useQuery({
    queryKey: ['playlists'],
    queryFn: api.playlistsWithWatchLater,
  })

  const create = useMutation({
    mutationFn: () =>
      api.createPlaylist({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
      toast('재생목록을 만들었습니다.', 'success')
      setName('')
      setDescription('')
      setCreating(false)
    },
    onError: (error) =>
      toast(error instanceof Error ? error.message : '재생목록을 만들지 못했습니다.', 'error'),
  })

  const list = playlists.data?.playlists ?? []

  return (
    <div className="h-full overflow-y-auto overscroll-contain px-6 pb-24">
      <PageHeading
        title="재생목록"
        meta={
          list.length > 0
            ? `${list.length}개 목록 · 파일을 복사하지 않고 순서만 기억합니다.`
            : '보고 싶은 영상을 순서대로 모아 둘 수 있습니다.'
        }
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={15} />
            새 재생목록
          </Button>
        }
      />

      {playlists.isPending ? (
        <LoadingBlock label="재생목록을 불러오는 중" />
      ) : playlists.isError ? (
        <EmptyState
          title="재생목록을 불러오지 못했습니다"
          body={
            playlists.error instanceof Error ? playlists.error.message : '잠시 뒤 다시 시도해 주세요.'
          }
          icon={<ListVideo size={20} />}
          action={<Button onClick={() => playlists.refetch()}>다시 시도</Button>}
        />
      ) : list.length === 0 ? (
        <EmptyState
          title="재생목록이 없습니다"
          body="동영상을 보면서 재생목록에 담으면 여기에 순서대로 쌓입니다."
          icon={<ListVideo size={20} />}
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              첫 재생목록 만들기
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((playlist) => (
            <PlaylistCard key={playlist.id} playlist={playlist} />
          ))}
        </div>
      )}

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="새 재생목록"
        description="이름만 정하면 바로 담을 수 있습니다."
        footer={
          <>
            <Button onClick={() => setCreating(false)}>취소</Button>
            <Button
              variant="primary"
              disabled={!name.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? '만드는 중' : '만들기'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ink">이름</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="예: 주말에 볼 것"
              maxLength={80}
              autoFocus
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ink">설명 (선택)</span>
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="이 목록에 대한 메모"
              maxLength={500}
            />
          </label>
        </div>
      </Dialog>
    </div>
  )
}

function PlaylistCard({ playlist }: { playlist: PlaylistDTO }) {
  const watchLater = playlist.kind === 'watch_later'
  return (
    <Link
      to={`/playlists/${playlist.id}`}
      className="group flex flex-col overflow-hidden rounded-panel border border-line bg-panel transition-colors duration-150 hover:border-line-strong"
    >
      <div className="flex items-center gap-2.5 px-4 pt-3.5">
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
            watchLater ? 'bg-accent/15 text-accent' : 'bg-panel-2 text-faint',
          )}
        >
          {watchLater ? <Clock size={15} /> : <ListVideo size={15} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium text-ink">{playlist.name}</p>
          <p className="text-[11.5px] text-faint">{formatAgo(playlist.updatedAt)} 수정</p>
        </div>
        {watchLater ? (
          <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10.5px] font-medium text-accent">
            기본
          </span>
        ) : null}
      </div>
      <p className="mt-2 line-clamp-2 min-h-[34px] px-4 text-[12px] leading-relaxed text-muted">
        {playlist.description ?? (watchLater ? WATCH_LATER_HINT : '설명 없음')}
      </p>
      <div className="mt-2 flex items-center gap-2 border-t border-line/60 px-4 py-2 text-[11px] text-faint">
        <span>{formatCount(playlist.itemCount)}개</span>
        {playlist.itemCount > playlist.availableCount ? (
          <span className="inline-flex items-center gap-1 text-[#fbbf24]">
            <TriangleAlert size={10} />
            삭제된 파일 {formatCount(playlist.itemCount - playlist.availableCount)}개
          </span>
        ) : null}
      </div>
    </Link>
  )
}

export function PlaylistPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const detail = useQuery({
    queryKey: ['playlist', id],
    queryFn: () => api.playlist(id),
    enabled: Boolean(id),
  })
  const assets = useQuery({
    queryKey: ['playlist', id, 'assets'],
    queryFn: () => api.playlistAssets(id),
    enabled: Boolean(id),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['playlist', id] })
    queryClient.invalidateQueries({ queryKey: ['playlists'] })
  }

  const move = useMutation({
    mutationFn: ({ itemId, position }: { itemId: string; position: number }) =>
      api.movePlaylistItem(id, itemId, position),
    onSuccess: () => invalidate(),
    onError: (error) =>
      toast(error instanceof Error ? error.message : '순서를 바꾸지 못했습니다.', 'error'),
  })

  const remove = useMutation({
    mutationFn: (itemId: string) => api.removePlaylistItem(id, itemId),
    onSuccess: () => {
      invalidate()
      toast('목록에서 뺐습니다. 파일은 그대로 남아 있습니다.')
    },
    onError: (error) =>
      toast(error instanceof Error ? error.message : '목록에서 빼지 못했습니다.', 'error'),
  })

  const destroy = useMutation({
    mutationFn: () => api.deletePlaylist(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
      setConfirmDelete(false)
      toast('재생목록을 삭제했습니다.')
      navigate('/playlists')
    },
    onError: (error) =>
      toast(error instanceof Error ? error.message : '재생목록을 삭제하지 못했습니다.', 'error'),
  })

  const back = (
    <div className="pt-4">
      <Link
        to="/playlists"
        className="inline-flex items-center gap-1.5 text-[12.5px] text-muted transition-colors hover:text-ink"
      >
        <ArrowLeft size={14} />
        재생목록으로 돌아가기
      </Link>
    </div>
  )

  if (detail.isPending) {
    return (
      <div className="h-full px-6">
        {back}
        <LoadingBlock label="재생목록을 불러오는 중" />
      </div>
    )
  }

  const playlist = detail.data?.playlist
  if (detail.isError || !playlist) {
    return (
      <div className="h-full overflow-y-auto px-6 pb-24">
        {back}
        <PageHeading title="재생목록을 열 수 없습니다" />
        <EmptyState
          title="재생목록을 불러오지 못했습니다"
          body={
            detail.error instanceof Error ? detail.error.message : '삭제되었거나 주소가 잘못되었습니다.'
          }
          icon={<ListVideo size={20} />}
          action={<Button onClick={() => navigate('/playlists')}>재생목록 목록</Button>}
        />
      </div>
    )
  }

  const items = detail.data.items
  const playable = assets.data?.items ?? []
  const byId = new Map(playable.map((asset) => [asset.id, asset]))
  const play = (assetId?: string) => {
    const index = assetId ? playable.findIndex((asset) => asset.id === assetId) : 0
    if (playable.length === 0 || index < 0) return
    useViewer.getState().open(playable, index)
  }

  const drop = (target: number) => {
    const itemId = dragging
    setDragging(null)
    setDropIndex(null)
    if (!itemId) return
    const from = items.findIndex((item) => item.id === itemId)
    if (from === -1 || from === target) return
    move.mutate({ itemId, position: target })
  }

  return (
    <div className="h-full overflow-y-auto overscroll-contain px-6 pb-24">
      {back}
      <PageHeading
        title={playlist.name}
        meta={`${formatCount(playlist.itemCount)}개 · 재생 가능 ${formatCount(playlist.availableCount)}개`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={playable.length === 0}
              onClick={() => play()}
            >
              <Play size={13} />
              재생
            </Button>
            <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={13} />
              삭제
            </Button>
          </div>
        }
      />

      {playlist.description ? (
        <p className="mb-4 max-w-[720px] text-[12.5px] leading-relaxed text-muted">
          {playlist.description}
        </p>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          title="이 재생목록은 비어 있습니다"
          body="동영상을 보다가 재생목록에 담으면 여기에 순서대로 쌓입니다."
          icon={<ListVideo size={20} />}
          action={<Button onClick={() => navigate('/videos')}>동영상 보러 가기</Button>}
        />
      ) : (
        <ul className="space-y-1.5">
          {items.map((item, index) => {
            const asset = byId.get(item.assetId)
            return (
              <li
                key={item.id}
                draggable
                onDragStart={() => setDragging(item.id)}
                onDragEnd={() => {
                  setDragging(null)
                  setDropIndex(null)
                }}
                onDragOver={(event) => {
                  event.preventDefault()
                  setDropIndex(index)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  drop(index)
                }}
                className={cn(
                  'flex items-center gap-2.5 rounded-panel border bg-panel px-2.5 py-2 transition-colors',
                  dropIndex === index && dragging && dragging !== item.id
                    ? 'border-accent/60 bg-accent/5'
                    : 'border-line',
                  dragging === item.id && 'opacity-50',
                )}
              >
                <span
                  className="cursor-grab p-1 text-faint active:cursor-grabbing"
                  title="끌어서 순서 바꾸기"
                >
                  <GripVertical size={14} />
                </span>

                <span className="w-6 shrink-0 text-right text-[11.5px] tabular-nums text-faint">
                  {index + 1}
                </span>

                {asset ? (
                  <>
                    <button
                      type="button"
                      onClick={() => play(asset.id)}
                      title="이 영상부터 재생"
                      className="relative h-[52px] w-[92px] shrink-0 overflow-hidden rounded-lg bg-panel-2"
                    >
                      <Thumb
                        src={asset.thumbnails.small}
                        alt=""
                        className="h-full w-full"
                        fit="cover"
                      />
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12.5px] font-medium text-ink" title={asset.filename}>
                        {asset.filename}
                      </p>
                      <p className="mt-0.5 text-[11px] text-faint">
                        {[formatDuration(asset.durationMs), formatAgo(item.addedAt)].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                  </>
                ) : (
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="flex h-[52px] w-[92px] shrink-0 items-center justify-center rounded-lg bg-panel-2 text-faint">
                      <TriangleAlert size={15} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-[12.5px] font-medium text-muted">삭제된 파일</p>
                      <p className="mt-0.5 text-[11px] text-faint">
                        원본이 라이브러리에 없습니다. 목록에서 빼면 정리됩니다.
                      </p>
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  aria-label="목록에서 빼기"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(item.id)}
                  className="ml-auto rounded-md p-1.5 text-faint transition-colors hover:bg-raised hover:text-ink disabled:opacity-40"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="재생목록을 삭제할까요?"
        description="목록과 순서만 지웁니다. 파일은 그대로 남습니다."
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>취소</Button>
            <Button variant="danger" disabled={destroy.isPending} onClick={() => destroy.mutate()}>
              {destroy.isPending ? '삭제 중' : '목록 삭제'}
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-muted">
          <span className="font-medium text-ink">{playlist.name}</span> 목록이 사라지고, 담겨 있던
          동영상은 라이브러리에 그대로 있습니다.
        </p>
      </Dialog>
    </div>
  )
}
