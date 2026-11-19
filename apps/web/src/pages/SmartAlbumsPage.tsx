import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, FolderHeart, Pencil, Pin, PinOff, Plus, Star, Trash2, TriangleAlert } from 'lucide-react'
import type { SmartAlbumDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { formatAgo } from '../lib/format'
import { useUi } from '../store/ui'
import { AssetGallery } from '../components/AssetGallery'
import { AlbumDialog } from '../components/AlbumDialog'
import { EmptyState } from '../components/EmptyState'
import { PageHeading } from '../components/PageHeading'
import { Button } from '../components/ui/Button'
import { Dialog } from '../components/ui/Dialog'
import { LoadingBlock } from '../components/ui/Spinner'

export function SmartAlbumsPage() {
  const [creating, setCreating] = useState(false)
  const albums = useQuery({ queryKey: ['smart-albums'], queryFn: api.smartAlbums })
  const list = albums.data?.albums ?? []

  return (
    <div className="h-full overflow-y-auto overscroll-contain px-6 pb-24">
      <PageHeading
        title="스마트 앨범"
        meta={
          list.length > 0
            ? `${list.length}개 앨범 · 조건을 저장할 뿐 파일을 옮기지 않습니다.`
            : '조건을 저장하면 그 조건에 맞는 파일이 계속 모입니다.'
        }
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={15} />
            새 앨범
          </Button>
        }
      />

      {albums.isPending ? (
        <LoadingBlock label="앨범을 불러오는 중" />
      ) : albums.isError ? (
        <EmptyState
          title="앨범을 불러오지 못했습니다"
          body={albums.error instanceof Error ? albums.error.message : '잠시 뒤 다시 시도해 주세요.'}
          icon={<FolderHeart size={20} />}
          action={<Button onClick={() => albums.refetch()}>다시 시도</Button>}
        />
      ) : list.length === 0 ? (
        <EmptyState
          title="아직 앨범이 없습니다"
          body="앨범은 조건을 저장합니다. 파일을 복사하거나 옮기지 않고, 조건에 맞는 파일이 항상 최신 상태로 보입니다."
          icon={<FolderHeart size={20} />}
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              첫 앨범 만들기
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((album) => (
            <AlbumCard key={album.id} album={album} />
          ))}
        </div>
      )}

      <AlbumDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  )
}

function AlbumCard({ album }: { album: SmartAlbumDTO }) {
  return (
    <Link
      to={`/smart-albums/${album.id}`}
      className="group flex flex-col overflow-hidden rounded-panel border border-line bg-panel transition-colors duration-150 hover:border-line-strong"
    >
      <div className="flex items-center gap-2.5 px-4 pt-3.5">
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
            album.pinned ? 'bg-accent/15 text-accent' : 'bg-panel-2 text-faint',
          )}
        >
          <FolderHeart size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium text-ink">{album.name}</p>
          <p className="text-[11.5px] text-faint">{formatAgo(album.updatedAt)} 수정</p>
        </div>
        {album.pinned ? <Star size={13} className="shrink-0 fill-accent text-accent" /> : null}
      </div>
      <p className="mt-2 line-clamp-2 min-h-[34px] px-4 text-[12px] leading-relaxed text-muted">
        {album.description ?? '설명 없음'}
      </p>
      <div className="mt-2 flex items-center gap-2 border-t border-line/60 px-4 py-2">
        {album.filter.valid ? (
          <span className="text-[11px] text-faint">조건 저장됨</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] text-[#fbbf24]">
            <TriangleAlert size={10} />
            조건을 읽을 수 없음
          </span>
        )}
      </div>
    </Link>
  )
}

export function SmartAlbumPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const albumQuery = useQuery({
    queryKey: ['smart-album', id],
    queryFn: () => api.smartAlbum(id),
    enabled: Boolean(id),
  })

  const pin = useMutation({
    mutationFn: (pinned: boolean) => api.updateSmartAlbum(id, { pinned }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['smart-album', id], updated)
      queryClient.invalidateQueries({ queryKey: ['smart-albums'] })
      toast(updated.pinned ? '목록 위에 고정했습니다.' : '고정을 해제했습니다.', 'success')
    },
    onError: (error) =>
      toast(error instanceof Error ? error.message : '고정 상태를 바꾸지 못했습니다.', 'error'),
  })

  const destroy = useMutation({
    mutationFn: () => api.deleteSmartAlbum(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['smart-albums'] })
      queryClient.invalidateQueries({ queryKey: ['assets'] })
      setConfirmDelete(false)
      toast('앨범을 삭제했습니다. 파일은 그대로 남아 있습니다.')
      navigate('/smart-albums')
    },
    onError: (error) =>
      toast(error instanceof Error ? error.message : '앨범을 삭제하지 못했습니다.', 'error'),
  })

  const album = albumQuery.data
  const back = (
    <div className="pt-4">
      <Link
        to="/smart-albums"
        className="inline-flex items-center gap-1.5 text-[12.5px] text-muted transition-colors hover:text-ink"
      >
        <ArrowLeft size={14} />
        스마트 앨범으로 돌아가기
      </Link>
    </div>
  )

  if (albumQuery.isPending) {
    return (
      <div className="h-full px-6">
        {back}
        <LoadingBlock label="앨범을 불러오는 중" />
      </div>
    )
  }

  if (albumQuery.isError || !album) {
    return (
      <div className="h-full overflow-y-auto px-6 pb-24">
        {back}
        <PageHeading title="앨범을 열 수 없습니다" />
        <EmptyState
          title="앨범을 불러오지 못했습니다"
          body={
            albumQuery.error instanceof Error
              ? albumQuery.error.message
              : '삭제되었거나 주소가 잘못되었습니다.'
          }
          icon={<FolderHeart size={20} />}
          action={<Button onClick={() => navigate('/smart-albums')}>앨범 목록</Button>}
        />
      </div>
    )
  }

  const filter = album.filter
  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={() => setEditing(true)}>
        <Pencil size={13} />
        수정
      </Button>
      <Button
        size="sm"
        disabled={pin.isPending}
        onClick={() => pin.mutate(!album.pinned)}
      >
        {album.pinned ? <PinOff size={13} /> : <Pin size={13} />}
        {album.pinned ? '고정 해제' : '고정'}
      </Button>
      <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
        <Trash2 size={13} />
        삭제
      </Button>
    </div>
  )

  const dialog = (
    <>
      <AlbumDialog open={editing} onClose={() => setEditing(false)} album={album} />
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="앨범을 삭제할까요?"
        description="저장된 조건만 지웁니다. 파일은 그대로 남습니다."
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>취소</Button>
            <Button variant="danger" disabled={destroy.isPending} onClick={() => destroy.mutate()}>
              {destroy.isPending ? '삭제 중' : '앨범 삭제'}
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-muted">
          <span className="font-medium text-ink">{album.name}</span> 앨범의 조건과 이름만 사라지고,
          이 앨범에 모였던 동영상과 사진은 라이브러리에 그대로 있습니다.
        </p>
      </Dialog>
    </>
  )

  if (!filter.valid) {
    return (
      <div className="h-full overflow-y-auto px-6 pb-24">
        {back}
        <PageHeading
          title={album.name}
          meta={album.description ?? '저장된 조건을 읽을 수 없습니다.'}
          actions={actions}
        />
        <EmptyState
          title="저장된 조건을 읽을 수 없습니다"
          body={`${filter.error} 조건을 다시 만들면 이 앨범을 정상으로 되돌릴 수 있습니다.`}
          icon={<TriangleAlert size={20} />}
          action={
            <Button variant="primary" onClick={() => setEditing(true)}>
              조건 다시 만들기
            </Button>
          }
        />
        {dialog}
      </div>
    )
  }

  return (
    <>
      <AssetGallery
        title={album.name}
        filters={{ albumId: album.id, ...(album.sort ? { sort: album.sort } : {}) }}
        breadcrumb={back}
        subheader={
          album.description ? (
            <p className="mb-3 max-w-[720px] text-[12.5px] leading-relaxed text-muted">
              {album.description}
            </p>
          ) : null
        }
        actions={actions}
        emptyTitle="조건에 맞는 파일이 없습니다"
        emptyBody="조건을 조금 넓히면 더 많은 파일이 모입니다. 파일을 새로 스캔하면 자동으로 반영됩니다."
        emptyIcon={<FolderHeart size={20} />}
        emptyAction={
          <Button onClick={() => setEditing(true)}>
            <Pencil size={13} />
            조건 수정
          </Button>
        }
      />
      {dialog}
    </>
  )
}
