import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronLeft, ChevronRight, Eye, FolderPlus, Images, Shuffle, Tag, ThumbsUp, Trash2 } from 'lucide-react'
import type { FolderDTO, FolderSort } from '@mediavault/shared'
import { api } from '../lib/api'
import { invalidateVoteCaches } from '../lib/cachePatch'
import { cn } from '../lib/cn'
import {
  FOLDER_HEADER_HEIGHT,
  buildFlatFolderMasonry,
  buildFolderMasonry,
  collectVisibleFolderNodes,
  type FolderSectionInput,
  type PlacedFolderCard,
} from '../lib/folderLayout'
import { formatCount } from '../lib/format'
import { randomToken } from '../lib/random'
import { selectAlbumNeighbor, selectRandomAlbum } from '../lib/albumNavigation'
import { useViewer } from '../store/viewer'
import { useElementWidth, useMeasuredElement } from '../lib/hooks'
import { useUi } from '../store/ui'
import { Breadcrumbs } from '../components/Breadcrumbs'
import { EmptyState } from '../components/EmptyState'
import { FolderCard } from '../components/FolderCard'
import { LoadingBlock } from '../components/ui/Spinner'
import { PageHeading } from '../components/PageHeading'
import { Button } from '../components/ui/Button'
import { AssetGallery } from '../components/AssetGallery'
import { AlbumDeleteDialog } from '../components/AlbumDeleteDialog'

const FOLDER_SORTS: Array<{ value: FolderSort; label: string }> = [
  { value: 'random', label: '랜덤순' },
  { value: 'views', label: '조회수순' },
  { value: 'votes', label: 'Vote순' },
  { value: 'name', label: '이름순' },
  { value: 'date', label: '날짜순' },
]

function PositionedFolderCard({
  node,
  count,
  priority = false,
  onVote,
  onDelete,
}: {
  node: PlacedFolderCard
  count?: number
  priority?: boolean
  onVote: (folderId: string) => void
  onDelete: (folderId: string) => void
}) {
  return (
    <div
      className="absolute left-0 top-0"
      style={{
        width: node.width,
        transform: `translate3d(${node.left}px, ${node.top}px, 0)`,
      }}
    >
      <FolderCard
        folder={node.folder}
        count={count}
        width={node.width}
        imageHeight={node.imageHeight}
        priority={priority}
        onVote={onVote}
        onDelete={onDelete}
      />
    </div>
  )
}

function SubfolderGrid({
  folders,
  onVote,
  onDelete,
}: {
  folders: FolderDTO[]
  onVote: (folderId: string) => void
  onDelete: (folderId: string) => void
}) {
  const [widthRef, width] = useElementWidth<HTMLDivElement>()
  const layout = useMemo(() => buildFlatFolderMasonry(folders, width), [folders, width])

  return (
    <div ref={widthRef} className="relative mb-5" style={{ height: layout.totalHeight }}>
      {layout.cards.map((node) => (
        <PositionedFolderCard
          key={node.key}
          node={node}
          count={node.folder.assetCount}
          onVote={onVote}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}

export function FoldersPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const [sort, setSort] = useState<FolderSort>('random')
  const [deletingFolder, setDeletingFolder] = useState<FolderDTO | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const { attach: attachHeader, height: headerHeight } = useMeasuredElement<HTMLDivElement>()
  const [widthRef, width] = useElementWidth<HTMLDivElement>()

  const libraries = useQuery({ queryKey: ['libraries'], queryFn: api.libraries })
  const folders = useQuery({
    queryKey: ['folders', sort],
    queryFn: () => api.folders({ sort }),
  })

  const vote = useMutation({
    mutationFn: (folderId: string) => api.voteFolder(folderId, randomToken()),
    onSuccess: (updated) => {
      queryClient.setQueriesData<FolderDTO[]>({ queryKey: ['folders'] }, (list) =>
        list?.map((f) => (f.id === updated.id ? updated : f)),
      )
      invalidateVoteCaches(queryClient)
    },
    onError: () => toast('폴더 투표를 저장하지 못했습니다.', 'error'),
  })

  const handleVote = useCallback((id: string) => vote.mutate(id), [vote.mutate])

  const collections = useMemo(
    () => (folders.data ?? []).filter((folder) => folder.directImageCount > 0),
    [folders.data],
  )

  // Keep the visible gallery order for the next/previous album controls.
  useEffect(() => {
    if (folders.isSuccess) queryClient.setQueryData(['album-navigation'], collections.map((folder) => folder.id))
  }, [collections, folders.isSuccess, queryClient])

  const sectionInputs = useMemo<FolderSectionInput[]>(() => {
    const byLib = new Map<string, FolderDTO[]>()
    for (const folder of collections) {
      const list = byLib.get(folder.libraryId)
      if (list) list.push(folder)
      else byLib.set(folder.libraryId, [folder])
    }
    return (libraries.data ?? [])
      .map((library) => ({
        libraryId: library.id,
        libraryName: library.name,
        folders: byLib.get(library.id) ?? [],
      }))
      .filter((section) => section.folders.length > 0)
  }, [libraries.data, collections])

  const layout = useMemo(() => buildFolderMasonry(sectionInputs, width), [sectionInputs, width])

  const virtualizer = useVirtualizer({
    count: layout.bandCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => layout.bandHeight,
    overscan: 2,
    scrollMargin: headerHeight,
  })

  const virtualItems = virtualizer.getVirtualItems()
  const visibleNodes = useMemo(
    () =>
      collectVisibleFolderNodes(
        layout,
        virtualItems.map((item) => item.index),
      ),
    [layout, virtualItems],
  )

  const loading = libraries.isPending || folders.isPending

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto overscroll-contain workspace-page">
      <div ref={attachHeader}>
        <PageHeading
          title="사진"
          meta={loading ? '불러오는 중' : `${formatCount(collections.length)}개 폴더`}
          actions={
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="사진 폴더 도구">
              <Link to="/photos/tags">
                <Button size="sm"><Tag size={13} /> 사진 태그별 보기</Button>
              </Link>
              {FOLDER_SORTS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setSort(option.value)}
                  aria-pressed={sort === option.value}
                  className={cn(
                    'min-h-10 rounded-xl border px-3.5 text-[13px] font-medium transition-colors',
                    sort === option.value
                      ? 'border-accent/50 bg-accent/15 text-accent'
                      : 'border-line bg-panel text-muted hover:border-line-strong hover:text-ink',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          }
        />
      </div>

      {loading ? (
        <LoadingBlock />
      ) : sectionInputs.length === 0 ? (
        <EmptyState
          title="사진 폴더가 없습니다"
          body="설정에서 폴더를 라이브러리로 등록하면 폴더별로 사진이 모입니다."
          icon={<FolderPlus size={20} />}
          action={<Button onClick={() => navigate('/settings')}>라이브러리 추가</Button>}
        />
      ) : (
        <div ref={widthRef} className="relative" style={{ height: layout.totalHeight }}>
          {visibleNodes.map((node) =>
            node.kind === 'header' ? (
              <div
                key={node.key}
                className="absolute left-0 top-0 flex w-full items-center gap-2"
                style={{
                  height: FOLDER_HEADER_HEIGHT,
                  transform: `translate3d(0, ${node.top}px, 0)`,
                }}
              >
                <h2 className="text-[16px] font-semibold text-ink">{node.libraryName}</h2>
                <span className="text-[11.5px] text-muted">
                  {formatCount(node.folderCount)}개 폴더
                </span>
              </div>
            ) : (
              <PositionedFolderCard
                key={node.key}
                node={node}
                count={node.folder.directImageCount}
                priority={node.index < 12}
                onVote={handleVote}
                onDelete={(id) => setDeletingFolder((folders.data ?? []).find((folder) => folder.id === id) ?? null)}
              />
            ),
          )}
        </div>
      )}
      <AlbumDeleteDialog folder={deletingFolder} onClose={() => setDeletingFolder(null)} />
    </div>
  )
}

export function FolderPage() {
  const { folderId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const [deletingFolder, setDeletingFolder] = useState<FolderDTO | null>(null)

  const detail = useQuery({
    queryKey: ['folder', folderId],
    queryFn: () => api.folder(folderId ?? ''),
    enabled: Boolean(folderId),
  })
  const folders = useQuery({ queryKey: ['folders'], queryFn: () => api.folders() })

  const galleryOrder = queryClient.getQueryData<string[]>(['album-navigation'])
  const fallbackOrder = (folders.data ?? []).filter((item) => item.directImageCount > 0).map((item) => item.id)
  const activeOrder = galleryOrder?.filter((id) => fallbackOrder.includes(id)) ?? fallbackOrder
  const orderedAlbumIds = activeOrder.includes(folderId ?? '')
    ? activeOrder
    : [...activeOrder, ...fallbackOrder.filter((id) => !activeOrder.includes(id))]
  const goAlbum = (direction: 'prev' | 'next' | 'random') => {
    if (!folderId) return
    const id = direction === 'random'
      ? selectRandomAlbum(orderedAlbumIds, folderId)
      : selectAlbumNeighbor(orderedAlbumIds, folderId, direction)
    if (id && id !== folderId) navigate(`/folders/${encodeURIComponent(id)}`)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!folderId || useViewer.getState().items.length > 0 || document.querySelector('dialog[open]')) return
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey && event.key !== '<' && event.key !== '>') return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return
      if (event.key === 'ArrowLeft' || event.key === '<') goAlbum('prev')
      if (event.key === 'ArrowRight' || event.key === '>') goAlbum('next')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const vote = useMutation({
    mutationFn: (targetId: string) => api.voteFolder(targetId, randomToken()),
    onSuccess: (updated) => {
      if (updated.id === folderId) {
        queryClient.setQueryData(
          ['folder', folderId],
          (prev: { folder: FolderDTO; breadcrumb: FolderDTO[] } | undefined) =>
            prev ? { ...prev, folder: updated } : prev,
        )
      }
      queryClient.setQueriesData<FolderDTO[]>({ queryKey: ['folders'] }, (list) =>
        list?.map((f) => (f.id === updated.id ? updated : f)),
      )
      invalidateVoteCaches(queryClient)
    },
    onError: () => toast('폴더 투표를 저장하지 못했습니다.', 'error'),
  })

  const handleSubfolderVote = useCallback((id: string) => vote.mutate(id), [vote.mutate])

  if (!folderId) {
    return (
      <div className="h-full overflow-y-auto overscroll-contain workspace-page">
        <EmptyState title="폴더를 찾을 수 없습니다" body="폴더 목록에서 다시 선택해 주세요." />
      </div>
    )
  }

  if (detail.isPending) {
    return (
      <div className="h-full overflow-y-auto overscroll-contain workspace-page">
        <LoadingBlock />
      </div>
    )
  }

  if (detail.isError || !detail.data) {
    return (
      <div className="h-full overflow-y-auto overscroll-contain workspace-page pt-6">
        <EmptyState
          title="폴더를 찾을 수 없습니다"
          body="스캔 후 삭제되었을 수 있습니다."
          action={<Button onClick={() => navigate('/')}>사진 목록</Button>}
        />
      </div>
    )
  }

  const { folder, breadcrumb } = detail.data
  const children = (folders.data ?? []).filter((item) => item.parentId === folder.id)

  return (
    <>
    <AssetGallery
      title={folder.name}
      filters={{ folderId: folder.id }}
      meta={
        <span className="inline-flex flex-wrap items-center gap-3 tabular-nums">
          <span>{formatCount(folder.directImageCount)}개 사진</span>
          <span className="inline-flex items-center gap-1">
            <Eye size={12} />
            조회수 {formatCount(folder.viewCount)}
          </span>
          <span className="inline-flex items-center gap-1">
            <ThumbsUp size={12} />
            Vote {formatCount(folder.voteCount)}
          </span>
        </span>
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => goAlbum('prev')} disabled={orderedAlbumIds.length < 2} title="이전 앨범 (← 또는 <)">
            <ChevronLeft size={13} /> 이전 앨범
          </Button>
          <Button size="sm" onClick={() => goAlbum('next')} disabled={orderedAlbumIds.length < 2} title="다음 앨범 (→ 또는 >)">
            다음 앨범 <ChevronRight size={13} />
          </Button>
          <Button size="sm" onClick={() => goAlbum('random')} disabled={orderedAlbumIds.length < 2} title="다른 앨범 랜덤 이동">
            <Shuffle size={13} /> Shuffle
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => vote.mutate(folder.id)}
            disabled={vote.isPending}
          >
            <ThumbsUp size={13} />
            Vote {formatCount(folder.voteCount)}
          </Button>
          {folder.directImageCount > 0 ? (
            <Button size="sm" variant="danger" onClick={() => setDeletingFolder(folder)}>
              <Trash2 size={13} /> 앨범 삭제
            </Button>
          ) : null}
        </div>
      }
      groupByMonth={false}
      breadcrumb={<Breadcrumbs trail={breadcrumb} />}
      subheader={
        children.length > 0 ? (
          <SubfolderGrid
            folders={children}
            onVote={handleSubfolderVote}
            onDelete={(id) => setDeletingFolder(children.find((item) => item.id === id) ?? null)}
          />
        ) : null
      }
      hideEmpty={children.length > 0}
      emptyTitle="이 폴더가 비어 있습니다"
      emptyBody="지원하는 사진과 영상이 없거나 아직 스캔하지 않았습니다."
      emptyIcon={<Images size={20} />}
    />
    <AlbumDeleteDialog
      folder={deletingFolder}
      onClose={() => setDeletingFolder(null)}
      onAccepted={() => navigate('/')}
    />
    </>
  )
}
