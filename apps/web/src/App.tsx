import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useSearchParams,
} from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Aperture } from 'lucide-react'
import { api } from './lib/api'
import { AppShell } from './components/AppShell'
import { EmptyState } from './components/EmptyState'
import { Spinner } from './components/ui/Spinner'
import { Button } from './components/ui/Button'
import { LoginPage, SetupPage } from './pages/AuthPages'
import { FolderPage, FoldersPage } from './pages/FolderPages'
import { VideoTagsPage, VideosPage } from './pages/GalleryPages'
import { DuplicatesPage } from './pages/DuplicatesPage'
import { NotificationsPage } from './pages/NotificationsPage'
import { SearchPage } from './pages/SearchPage'
import { SettingsPage } from './pages/SettingsPage'

function Splash() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5">
      <div className="flex items-center gap-2.5 text-ink">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/15 text-accent">
          <Aperture size={19} />
        </span>
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
          <Route path="videos/tags" element={<VideoTagsPage />} />
          <Route path="videos/tags/:tagId" element={<VideoTagsPage />} />
          <Route path="folders" element={<Navigate to="/" replace />} />
          <Route path="folders/:folderId" element={<FolderPage />} />
          <Route path="search" element={<SearchRoute />} />
          <Route path="duplicates" element={<DuplicatesPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
