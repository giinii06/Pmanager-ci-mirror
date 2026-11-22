import { useEffect, useState } from 'react'
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useSearchParams,
  useParams,
} from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { BrandMark } from './components/BrandMark'
import { api } from './lib/api'
import { AppShell } from './components/AppShell'
import { useViewer } from './store/viewer'
import { EmptyState } from './components/EmptyState'
import { Spinner } from './components/ui/Spinner'
import { Button } from './components/ui/Button'
import { LoginPage, SetupPage } from './pages/AuthPages'
import { FolderPage, FoldersPage } from './pages/FolderPages'
import { PhotoTagsPage, VideoTagsPage, VideosPage } from './pages/GalleryPages'
import { NotificationsPage } from './pages/NotificationsPage'
import { SearchPage } from './pages/SearchPage'
import { SettingsPage } from './pages/SettingsPage'
import { JournalIndexPage, JournalEditPage } from './pages/JournalPage'

function Splash() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5">
      <div className="flex items-center gap-2.5 text-ink">
        <BrandMark size={36} />
        <span className="text-[16px] font-semibold tracking-tight">MediaVault</span>
      </div>
      <Spinner />
    </div>
  )
}

function BootError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <EmptyState
        title="서버에 연결할 수 없습니다"
        body="API가 실행 중인지 확인한 뒤 다시 시도해 주세요."
        action={<Button onClick={onRetry}>다시 시도</Button>}
      />
    </div>
  )
}

function SearchRoute() {
  const [params] = useSearchParams()
  return <SearchPage query={params.get('q') ?? ''} />
}

/** Resolve direct photo and video URLs and synchronize browser history. */
function MediaRoute({ kind }: { kind: 'image' | 'video' }) {
  const { assetId } = useParams()
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  useEffect(() => {
    if (!assetId) return
    setError(null)
    const state = useViewer.getState()
    if (state.items[state.index]?.id === assetId && state.items[state.index]?.kind === kind) return
    const cached = state.items.find((item) => item.id === assetId)
    if (cached && cached.kind === kind) {
      state.select(cached)
      return
    }
    let cancelled = false
    void api.asset(assetId).then((item) => {
      if (cancelled) return
      if (item.kind !== kind) {
        setError('주소에 해당하는 미디어 종류가 다릅니다.')
        return
      }
      useViewer.getState().open([item], 0, { filter: { kind } })
    }).catch(() => { if (!cancelled) setError('미디어를 찾을 수 없거나 접근할 수 없습니다.') })
    return () => { cancelled = true }
  }, [assetId, kind])
  return error ? (
    <div className="workspace-page">
      <EmptyState title="미디어를 열지 못했습니다" body={error}
        action={<Button onClick={() => navigate(kind === 'video' ? '/videos' : '/')}>목록으로 돌아가기</Button>} />
    </div>
  ) : <div className="h-full bg-canvas" />
}

function NotFound() {
  const navigate = useNavigate()
  return (
    <div className="h-full overflow-y-auto overscroll-contain px-6 pt-6">
      <EmptyState
        title="페이지를 찾을 수 없습니다"
        body="주소가 바뀌었거나 삭제되었습니다."
        action={<Button onClick={() => navigate('/')}>사진</Button>}
      />
    </div>
  )
}

export function App() {
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.status, retry: 0, staleTime: 0 })

  if (auth.isPending) return <Splash />
  if (auth.isError) return <BootError onRetry={() => auth.refetch()} />
  if (auth.data.setupRequired) return <SetupPage />
  if (!auth.data.authenticated) return <LoginPage />

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<FoldersPage />} />
          <Route path="videos" element={<VideosPage />} />
          <Route path="videos/:assetId" element={<MediaRoute kind="video" />} />
          <Route path="photos/:assetId" element={<MediaRoute kind="image" />} />
          <Route path="videos/tags" element={<VideoTagsPage />} />
          <Route path="videos/tags/:tagId" element={<VideoTagsPage />} />
          <Route path="photos/tags" element={<PhotoTagsPage />} />
          <Route path="photos/tags/:tagId" element={<PhotoTagsPage />} />
          <Route path="folders" element={<Navigate to="/" replace />} />
          <Route path="folders/:folderId" element={<FolderPage />} />
          <Route path="search" element={<SearchRoute />} />
          <Route path="duplicates" element={<Navigate to="/" replace />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="journal" element={<JournalIndexPage />} />
          <Route path="journal/:id" element={<JournalEditPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
