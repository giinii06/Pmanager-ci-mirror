import { useNavigate, useParams } from 'react-router-dom'
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
      <PageHeading title="사진 모음" meta={`${formatCount(collections.length)}개 폴더`} />

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
                <FolderCard key={folder.id} folder={folder} count={folder.directImageCount} />
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
          action={<Button onClick={() => navigate('/')}>사진 모음</Button>}
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
