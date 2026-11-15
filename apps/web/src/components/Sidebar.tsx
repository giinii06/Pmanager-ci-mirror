import { useEffect } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Aperture,
  Film,
  FolderTree as FolderTreeIcon,
  Heart,
  Loader2,
  Settings2,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { formatCount } from '../lib/format'
import { useUi } from '../store/ui'
import { FolderTree } from './FolderTree'

const navItems = [
  { to: '/', label: '사진 모음', icon: FolderTreeIcon, count: null, end: true },
  { to: '/videos', label: '동영상', icon: Film, count: 'videos' as const, end: false },
  { to: '/favorites', label: '즐겨찾기', icon: Heart, count: 'favorites' as const, end: false },
]

export function Sidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const sidebarOpen = useUi((state) => state.sidebarOpen)
  const setSidebarOpen = useUi((state) => state.setSidebarOpen)

  const libraries = useQuery({ queryKey: ['libraries'], queryFn: api.libraries })
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.folders })
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const jobs = useQuery({
    queryKey: ['jobs'],
    queryFn: api.jobs,
    refetchInterval: 6000,
  })

  useEffect(() => {
    setSidebarOpen(false)
  }, [location.pathname, setSidebarOpen])

  const activeJobs = (jobs.data?.counts.queued ?? 0) + (jobs.data?.counts.running ?? 0)

  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-50 flex w-[248px] shrink-0 flex-col border-r border-line bg-panel transition-transform duration-200 md:static md:translate-x-0',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full',
      )}
    >
      <div className="flex h-14 items-center justify-between px-4">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="flex items-center gap-2.5 rounded-lg text-left"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Aperture size={16} />
          </span>
          <span className="text-[14px] font-semibold tracking-tight text-ink">MediaVault</span>
        </button>
        <button
          type="button"
          onClick={() => setSidebarOpen(false)}
          className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-ink md:hidden"
          aria-label="메뉴 닫기"
        >
          <X size={16} />
        </button>
      </div>

      <nav className="space-y-0.5 px-2.5">
        {navItems.map((item) => {
          const Icon = item.icon
          const count = item.count ? stats.data?.[item.count] : undefined
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors',
                  isActive
                    ? 'bg-accent/12 text-accent'
                    : 'text-muted hover:bg-white/[0.045] hover:text-ink',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={15} className={isActive ? 'text-accent' : 'text-faint'} />
                  <span className="flex-1">{item.label}</span>
                  {typeof count === 'number' && count > 0 ? (
                    <span className="text-[10.5px] tabular-nums text-faint">
                      {formatCount(count)}
                    </span>
                  ) : null}
                </>
              )}
            </NavLink>
          )
        })}
      </nav>

      <div className="mt-6 flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-4 pb-1.5">
          <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-faint">
            라이브러리
          </span>
          <button
            type="button"
            onClick={() => navigate('/settings')}
            aria-label="라이브러리 설정"
            className="rounded p-1 text-faint transition-colors hover:bg-raised hover:text-ink"
          >
            <Settings2 size={13} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
          {libraries.data?.length ? (
            libraries.data.map((library) => {
              const root = folders.data?.find(
                (folder) => folder.libraryId === library.id && folder.parentId === null,
              )
              const scanning = library.scanState !== 'idle'
              return (
                <div key={library.id} className="mb-1.5">
                  <button
                    type="button"
                    onClick={() => root && navigate(`/folders/${root.id}`)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors',
                      'text-[12.5px] text-ink hover:bg-white/[0.045]',
                    )}
                  >
                    <span className="flex-1 truncate font-medium">{library.name}</span>
                    {scanning ? (
                      <Loader2 size={12} className="animate-spin text-accent" />
                    ) : (
                      <span className="text-[10.5px] tabular-nums text-faint">
                        {formatCount(library.assetCount)}
                      </span>
                    )}
                  </button>
                  <FolderTree libraryId={library.id} folders={folders.data ?? []} />
                </div>
              )
            })
          ) : (
            <p className="px-2.5 py-2 text-[12px] leading-relaxed text-faint">
              등록된 라이브러리가 없습니다.
            </p>
          )}
        </div>
      </div>

      <div className="border-t border-line px-3 py-2.5">
        <div className="flex items-center gap-2 text-[11.5px] text-muted">
          {activeJobs > 0 ? (
            <>
              <Loader2 size={12} className="animate-spin text-accent" />
              <span>{formatCount(activeJobs)}개 작업 처리 중</span>
            </>
          ) : (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-[#4ade80]/70" />
              <span>준비됨</span>
            </>
          )}
          <button
            type="button"
            onClick={() => navigate('/settings')}
            className="ml-auto rounded p-1 text-faint transition-colors hover:bg-raised hover:text-ink"
            aria-label="설정"
          >
            <Settings2 size={14} />
          </button>
        </div>
      </div>
    </aside>
  )
}
