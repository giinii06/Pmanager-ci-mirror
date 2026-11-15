import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { FolderPlus, Images } from 'lucide-react'
import { api } from '../lib/api'
import { formatCount } from '../lib/format'
import { Breadcrumbs } from '../components/Breadcrumbs'
import { EmptyState } from '../components/EmptyState'
import { FolderCard } from '../components/FolderCard'
import { LoadingBlock } from '../components/ui/Spinner'
import { PageHeading } from '../components/PageHeading'
import { Button } from '../components/ui/Button'
import { AssetGallery } from '../components/AssetGallery'

const CARD_GRID = 'grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4'

export function FoldersPage() {
  const navigate = useNavigate()
  const libraries = useQuery({ queryKey: ['libraries'], queryFn: api.libraries })
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.folders })
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })

  if (libraries.isPending || folders.isPending) {
    return (
      <div className="h-full overflow-y-auto px-6">
        <LoadingBlock />
      </div>
    )
  }

  const sections = (libraries.data ?? []).map((library) => {
    const root = folders.data?.find(
      (folder) => folder.libraryId === library.id && folder.parentId === null,
    )
    const top = root ? (folders.data ?? []).filter((folder) => folder.parentId === root.id) : []
    return { library, root, top }
  })

  return (
    <div className="h-full overflow-y-auto px-6 pb-24">
      <PageHeading
        title="폴더"
        meta={`${formatCount(stats.data?.folders ?? 0)}개 폴더`}
        actions={<Button onClick={() => navigate('/settings')}>라이브러리 관리</Button>}
      />

      {sections.length === 0 ? (
        <EmptyState
          title="폴더가 없습니다"
          body="설정에서 원본 폴더를 라이브러리로 등록하면 폴더 구조를 그대로 읽어옵니다."
          icon={<FolderPlus size={20} />}
          action={<Button onClick={() => navigate('/settings')}>라이브러리 추가</Button>}
        />
      ) : (
        sections.map(({ library, root, top }) => (
          <section key={library.id} className="mb-9">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="text-[14px] font-semibold text-ink">{library.name}</h2>
              <span className="text-[11.5px] text-muted">
                {formatCount(library.assetCount)}개
              </span>
              {root ? (
                <Link
                  to={`/folders/${root.id}`}
                  className="ml-auto text-[12px] text-muted transition-colors hover:text-ink"
                >
                  전체 보기
                </Link>
              ) : (
                <span className="ml-auto text-[11.5px] text-faint">아직 스캔하지 않았습니다</span>
              )}
            </div>
            {top.length > 0 ? (
              <div className={CARD_GRID}>
                {top.map((folder) => (
                  <FolderCard key={folder.id} folder={folder} />
                ))}
              </div>
            ) : (
              <p className="rounded-panel border border-dashed border-line px-4 py-6 text-[12.5px] text-faint">
                {library.scanState === 'idle'
                  ? '이 라이브러리에 표시할 하위 폴더가 없습니다.'
                  : '폴더를 읽는 중입니다.'}
              </p>
            )}
          </section>
        ))
      )}
    </div>
  )
}

export function FolderPage() {
  const { folderId } = useParams()
  const navigate = useNavigate()
  const detail = useQuery({
    queryKey: ['folder', folderId],
    queryFn: () => api.folder(folderId ?? ''),
    enabled: Boolean(folderId),
  })
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.folders })

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
          action={<Button onClick={() => navigate('/folders')}>폴더 목록</Button>}
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
      meta={`${formatCount(folder.assetCount)}개`}
      breadcrumb={<Breadcrumbs trail={breadcrumb} />}
      subheader={
        children.length > 0 ? (
          <div className={`${CARD_GRID} pb-5`}>
            {children.map((child) => (
              <FolderCard key={child.id} folder={child} />
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
