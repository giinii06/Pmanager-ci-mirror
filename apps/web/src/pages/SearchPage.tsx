import { Search } from 'lucide-react'
import { AssetGallery } from '../components/AssetGallery'
import { EmptyState } from '../components/EmptyState'
import { PageHeading } from '../components/PageHeading'

/** The global search is a filename filter over the same paginated media gallery. */
export function SearchPage({ query }: { query: string }) {
  const name = query.trim()

  if (!name) {
    return (
      <div className="h-full overflow-y-auto workspace-page">
        <PageHeading title="파일 이름 검색" />
        <EmptyState
          title="찾을 파일 이름을 입력하세요"
          body="사진과 동영상의 파일 이름에서 일치하는 부분을 찾습니다."
          icon={<Search size={20} />}
        />
      </div>
    )
  }

  return (
    <AssetGallery
      title={'“' + name + '” 검색 결과'}
      filters={{ q: name, sort: 'latest' }}
      showFilenames
      emptyTitle="일치하는 파일이 없습니다"
      emptyBody="다른 파일 이름이나 더 짧은 단어로 검색해 보세요."
      emptyIcon={<Search size={20} />}
    />
  )
}
