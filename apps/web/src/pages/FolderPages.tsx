import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, FolderPlus, Images, ThumbsUp } from 'lucide-react'
import type { FolderDTO, FolderSort } from '@mediavault/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { formatCount } from '../lib/format'
import { useUi } from '../store/ui'
import { Breadcrumbs } from '../components/Breadcrumbs'
import { EmptyState } from '../components/EmptyState'
import { FolderCard } from '../components/FolderCard'
import { LoadingBlock } from '../components/ui/Spinner'
import { PageHeading } from '../components/PageHeading'
import { Button } from '../components/ui/Button'
import { AssetGallery } from '../components/AssetGallery'

const CARD_GRID = 'grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4'

const FOLDER_SORTS: Array<{ value: FolderSort; label: string }> = [
  { value: 'views', label: '조회수순' },
  { value: 'votes', label: 'Vote순' },
  { value: 'name', label: '이름순' },
  { value: 'date', label: '날짜순' },
]

export function FoldersPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const [sort, setSort] = useState<FolderSort>('views')

  const libraries = useQuery({ queryKey: ['libraries'], queryFn: api.libraries })
  const folders = useQuery({
    queryKey: ['folders', sort],
    queryFn: () => api.folders({ sort }),
  })

  const vote = useMutation({
    mutationFn: (folderId: string) => api.voteFolder(folderId),
    onSuccess: (updated) => {
      queryClient.setQueriesData<FolderDTO[]>({ queryKey: ['folders'] }, (list) =>
        list?.map((f) => (f.id === updated.id ? updated : f)),
      )
    },
    onError: () => toast('폴더 투표를 저장하지 못했습니다.', 'error'),
  })

  if (libraries.isPending || folders.isPending) {
    return (
      <div className="h-full overflow-y-auto px-6">
        <LoadingBlock />
      </div>
    )
  }

  const collections = (folders.data ?? []).filter((folder) => folder.directImageCount > 0)
  const sections = (libraries.data ?? [])
    .map((library) => ({
      library,
      folders: collections.filter((folder) => folder.libraryId === library.id),
    }))
    .filter((section) => section.folders.length > 0)

  return (
    <div className="h-full overflow-y-auto px-6 pb-24">
      <PageHeading
        title="사진"
        meta={`${formatCount(collections.length)}개 폴더`}
        actions={
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="폴더 정렬">
            {FOLDER_SORTS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setSort(option.value)}
                aria-pressed={sort === option.value}
                className={cn(
                  'h-8 rounded-lg border px-2.5 text-[12px] font-medium transition-colors',
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

      {sections.length === 0 ? (
        <EmptyState
          title="사진 폴더가 없습니다"
          body="설정에서 폴더를 라이브러리로 등록하면 폴더별로 사진이 모입니다."
          icon={<FolderPlus size={20} />}
          action={<Button onClick={() => navigate('/settings')}>라이브러리 추가</Button>}
        />
      ) : (
        sections.map((section) => (
          <section key={section.library.id} className="mb-9">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="text-[14px] font-semibold text-ink">{section.library.name}</h2>
              <span className="text-[11.5px] text-muted">
                {formatCount(section.folders.length)}개 폴더
              </span>
            </div>
            <div className={CARD_GRID}>
              {section.folders.map((folder) => (
                <FolderCard
                  key={folder.id}
                  folder={folder}
                  count={folder.directImageCount}
                  onVote={(id) => vote.mutate(id)}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}

export function FolderPage() {
  const { folderId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)

  const detail = useQuery({
    queryKey: ['folder', folderId],
    queryFn: () => api.folder(folderId ?? ''),
    enabled: Boolean(folderId),
  })
  const folders = useQuery({ queryKey: ['folders'], queryFn: () => api.folders() })

  const vote = useMutation({
    mutationFn: (targetId: string) => api.voteFolder(targetId),
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
    },
    onError: () => toast('폴더 투표를 저장하지 못했습니다.', 'error'),
  })

  if (!folderId) {
    return (
      <div className="px-6 pb-24">
        <EmptyState title="폴더를 찾을 수 없습니다" body="폴더 목록에서 다시 선택해 주세요." />
      </div>
    )
  }

  if (detail.isPending) {
    return (
      <div className="h-full overflow-y-auto px-6">
        <LoadingBlock />
      </div>
    )
  }

  if (detail.isError || !detail.data) {
    return (
      <div className="px-6 pb-24 pt-6">
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
        <Button
          size="sm"
          variant="primary"
          onClick={() => vote.mutate(folder.id)}
          disabled={vote.isPending}
        >
          <ThumbsUp size={13} />
          Vote {formatCount(folder.voteCount)}
        </Button>
      }
      groupByMonth={false}
      breadcrumb={<Breadcrumbs trail={breadcrumb} />}
      subheader={
        children.length > 0 ? (
          <div className={`${CARD_GRID} pb-5`}>
            {children.map((child) => (
              <FolderCard
                key={child.id}
                folder={child}
                onVote={(id) => vote.mutate(id)}
              />
            ))}
          </div>
        ) : null
      }
      hideEmpty={children.length > 0}
      emptyTitle="이 폴더가 비어 있습니다"
      emptyBody="지원하는 사진과 영상이 없거나 아직 스캔하지 않았습니다."
      emptyIcon={<Images size={20} />}
    />
  )
}
