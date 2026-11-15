import { useEffect, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Images, Film, Heart } from 'lucide-react'
import { api } from '../lib/api'
import { useUi } from '../store/ui'
import { useViewer } from '../store/viewer'
import { AssetGallery } from '../components/AssetGallery'
import { EmptyState } from '../components/EmptyState'
import { PageHeading } from '../components/PageHeading'
import { Button } from '../components/ui/Button'

export function VideosPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const sharedId = params.get('v')
  const openedFor = useRef<string | null>(null)

  // A shared watch link carries the video id. Open it once, then drop the
  // parameter so closing the viewer leaves the plain gallery behind.
  useEffect(() => {
    if (!sharedId || openedFor.current === sharedId) return
    openedFor.current = sharedId
    setParams(
      (current) => {
        current.delete('v')
        return current
      },
      { replace: true },
    )
    void api
      .asset(sharedId)
      .then((asset) => {
        if (asset.kind === 'video') useViewer.getState().open([asset], 0)
      })
      .catch(() => {
        useUi.getState().toast('공유된 영상을 열 수 없습니다.', 'error')
      })
  }, [sharedId, setParams])

  return (
    <AssetGallery
      title="동영상"
      filters={{ kind: 'video' }}
      emptyTitle="동영상이 없습니다"
      emptyBody="MP4, MOV, MKV, WebM 파일을 스캔하면 여기에 모입니다. 브라우저가 재생하지 못하는 형식은 필요할 때 HLS로 변환합니다."
      emptyIcon={<Film size={20} />}
      emptyAction={<Button onClick={() => navigate('/settings')}>라이브러리 추가</Button>}
    />
  )
}

export function FavoritesPage() {
  const navigate = useNavigate()
  return (
    <AssetGallery
      title="즐겨찾기"
      filters={{ favorite: true }}
      emptyTitle="즐겨찾기가 비어 있습니다"
      emptyBody="사진 위에 마우스를 올리고 하트를 누르면 여기에 모입니다."
      emptyIcon={<Heart size={20} />}
      emptyAction={<Button onClick={() => navigate('/')}>사진 모음 보기</Button>}
    />
  )
}

export function SearchPage({ query }: { query: string }) {
  if (!query) {
    return (
      <div className="px-6 pb-24">
        <PageHeading title="검색" />
        <EmptyState
          title="검색어를 입력하세요"
          body="상단 검색창에 파일 이름의 일부를 입력하면 바로 찾습니다."
          icon={<Images size={20} />}
        />
      </div>
    )
  }
  return (
    <AssetGallery
      title={`검색: ${query}`}
      filters={{ q: query }}
      emptyTitle="검색 결과가 없습니다"
      emptyBody="다른 파일 이름으로 다시 찾아보세요."
      emptyIcon={<Images size={20} />}
    />
  )
}
