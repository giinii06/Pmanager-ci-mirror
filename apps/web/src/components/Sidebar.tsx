import { useEffect, type ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BookOpenText, Film, Images, Loader2,
  PanelLeftOpen, Plus, Settings2, Tag, X,
} from 'lucide-react'
import { api } from '../lib/api'
import { BrandMark } from './BrandMark'
import { cn } from '../lib/cn'
import { formatCount } from '../lib/format'
import { useUi } from '../store/ui'

function GroupLabel({ children, collapsed }: { children: ReactNode; collapsed: boolean }) {
  return <p className={cn('px-3 pb-2 pt-5 text-[11px] font-semibold tracking-wide text-faint', collapsed && 'md:sr-only')}>{children}</p>
}

function MainLink({
  to, label, icon, active, collapsed, count, end,
}: {
  to: string
  label: string
  icon: ReactNode
  active: boolean
  collapsed: boolean
  count?: number
  end?: boolean
}) {
  return (
    <NavLink
      to={to}
      end={end}
      title={label}
      aria-label={label}
      className={cn(
        'group flex min-h-11 items-center gap-3 rounded-xl px-3.5 text-[14px] font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent',
        collapsed && 'md:justify-center md:px-0',
        active
          ? 'bg-accent/12 text-accent'
          : 'text-muted hover:bg-raised/65 hover:text-ink',
      )}
    >
      <span className={cn('flex shrink-0 items-center justify-center', active ? 'text-accent' : 'text-faint group-hover:text-ink')}>
        {icon}
      </span>
      <span className={cn('min-w-0 flex-1 truncate', collapsed && 'md:hidden')}>{label}</span>
      {typeof count === 'number' && count > 0 ? (
        <span className={cn('rounded-lg bg-panel-2 px-1.5 py-0.5 text-[11px] tabular-nums text-faint', collapsed && 'md:hidden')}>
          {formatCount(count)}
        </span>
      ) : null}
    </NavLink>
  )
}

export function Sidebar({ peek = false }: { peek?: boolean }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const location = useLocation()
  const sidebarOpen = useUi((state) => state.sidebarOpen)
  const setSidebarOpen = useUi((state) => state.setSidebarOpen)
  const savedCollapsed = useUi((state) => state.sidebarCollapsed)
  const collapsed = savedCollapsed && !peek && !sidebarOpen
  const toggleCollapsed = useUi((state) => state.toggleSidebarCollapsed)

  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: api.jobs, refetchInterval: 6000 })

  useEffect(() => {
    setSidebarOpen(false)
  }, [location.pathname, setSidebarOpen])

  const pathname = location.pathname
  const activeJobs = (jobs.data?.counts.queued ?? 0) + (jobs.data?.counts.running ?? 0)
  const inPhotos = pathname === '/' || pathname.startsWith('/folders') || pathname.startsWith('/photos')
  const inVideos = pathname.startsWith('/videos')
  const inJournal = pathname.startsWith('/journal')
  const journal = useQuery({
    queryKey: ['journal', 'recent'],
    queryFn: () => api.journalEntries(),
    enabled: inJournal,
  })
  const createJournal = useMutation({
    mutationFn: api.createJournalEntry,
    onSuccess: (entry) => {
      void queryClient.invalidateQueries({ queryKey: ['journal'] })
      navigate('/journal/' + entry.id)
    },
    onError: () => toast('새 일지를 만들지 못했습니다.', 'error'),
  })

  return (
    <aside
      aria-label="사이드바"
      inert={savedCollapsed && !peek && !sidebarOpen}
      className={cn(
        'fixed inset-y-0 left-0 z-50 flex w-[284px] shrink-0 flex-col border-r border-line bg-panel shadow-2xl',
        'transition-[transform,width] duration-200 md:w-[268px] md:translate-x-0',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        savedCollapsed && !peek
          ? 'md:static md:w-0 md:overflow-hidden md:border-r-0 md:shadow-none'
          : peek ? 'md:fixed md:shadow-2xl' : 'md:static md:shadow-none',
      )}
    >
      <div className={cn('flex min-h-[76px] items-center gap-3 border-b border-line/70 px-4', collapsed && 'md:justify-center md:px-2')}>
        <button
          type="button"
          onClick={() => navigate('/')}
          title="MediaVault 홈"
          aria-label="MediaVault 홈"
          className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left focus-visible:outline-2 focus-visible:outline-accent"
        >
          <BrandMark size={44} />
          <span className={cn('min-w-0 flex-1', collapsed && 'md:hidden')}>
            <span className="block truncate text-[16px] font-bold tracking-tight text-ink">MediaVault</span>
            <span className="block truncate text-[11px] text-faint">나만의 미디어 공간</span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => setSidebarOpen(false)}
          aria-label="메뉴 닫기"
          className="rounded-xl p-2 text-muted hover:bg-raised hover:text-ink md:hidden"
        >
          <X size={19} />
        </button>
      </div>

      <nav aria-label="주 메뉴" className={cn('min-h-0 flex-1 overflow-y-auto px-3 pb-5 pt-1', collapsed && 'md:px-2')}>
        {collapsed ? (
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label="사이드바 펼치기"
            title="사이드바 펼치기"
            className="mx-auto mt-2 hidden h-10 w-10 items-center justify-center rounded-xl text-muted hover:bg-raised hover:text-ink md:flex"
          >
            <PanelLeftOpen size={18} />
          </button>
        ) : null}
        <GroupLabel collapsed={collapsed}>라이브러리</GroupLabel>
        <div className="space-y-1">
          <MainLink to="/" label="사진" icon={<Images size={19} />} active={inPhotos} collapsed={collapsed} count={stats.data?.images} end />
          <NavLink
            to="/photos/tags"
            title="사진 태그"
            className={({ isActive }) => cn(
              'ml-10 flex min-h-9 items-center gap-2 rounded-xl px-3 text-[12.5px] transition-colors',
              collapsed && 'md:hidden',
              isActive ? 'bg-panel-2 font-semibold text-ink' : 'text-muted hover:bg-raised/60 hover:text-ink',
            )}
          >
            <Tag size={14} /> 사진 태그로 모아보기
          </NavLink>
          <MainLink to="/videos" label="동영상" icon={<Film size={19} />} active={inVideos} collapsed={collapsed} count={stats.data?.videos} />
          <NavLink
            to="/videos/tags"
            title="영상 태그"
            className={({ isActive }) => cn(
              'ml-10 flex min-h-9 items-center gap-2 rounded-xl px-3 text-[12.5px] transition-colors',
              collapsed && 'md:hidden',
              isActive ? 'bg-panel-2 font-semibold text-ink' : 'text-muted hover:bg-raised/60 hover:text-ink',
            )}
          >
            <Tag size={14} /> 태그로 모아보기
          </NavLink>
        </div>

        <GroupLabel collapsed={collapsed}>기록과 정리</GroupLabel>
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <MainLink to="/journal" label="일지" icon={<BookOpenText size={19} />} active={inJournal} collapsed={collapsed} />
            </div>
            <button
              type="button"
              aria-label="새 일지 만들기"
              title="새 일지 만들기"
              disabled={createJournal.isPending}
              onClick={() => createJournal.mutate()}
              className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-faint hover:bg-raised hover:text-ink disabled:opacity-45', collapsed && 'md:hidden')}
            >
              {createJournal.isPending ? <Loader2 size={16} className="animate-spin" /> : <Plus size={17} />}
            </button>
          </div>
          {inJournal && !collapsed && journal.data?.items.length ? (
            <div className="space-y-0.5 pb-1 pl-10 pr-1">
              {journal.data.items.slice(0, 10).map((entry) => (
                <NavLink
                  key={entry.id}
                  to={'/journal/' + entry.id}
                  title={entry.title || '제목 없음'}
                  className={({ isActive }) => cn(
                    'block truncate rounded-lg px-2.5 py-2 text-[12.5px] transition-colors',
                    isActive ? 'bg-panel-2 font-medium text-ink' : 'text-muted hover:bg-raised/60 hover:text-ink',
                  )}
                >
                  {entry.title || '제목 없음'}
                </NavLink>
              ))}
            </div>
          ) : null}
        </div>

        <GroupLabel collapsed={collapsed}>환경 설정</GroupLabel>
        <MainLink to="/settings" label="설정" icon={<Settings2 size={19} />} active={pathname.startsWith('/settings')} collapsed={collapsed} />
      </nav>

      <div className={cn('border-t border-line px-4 py-4', collapsed && 'md:px-2')}>
        <div className={cn('flex min-h-12 items-center gap-3 rounded-2xl bg-canvas/70 px-3.5', collapsed && 'md:justify-center md:px-0')}>
          {activeJobs > 0
            ? <Loader2 size={17} className="shrink-0 animate-spin text-accent" />
            : <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500" />}
          <div className={cn('min-w-0', collapsed && 'md:hidden')}>
            <span className="block text-[12.5px] font-semibold text-ink">{activeJobs > 0 ? '처리 중' : '모든 작업 준비됨'}</span>
            <span className="block text-[11px] text-muted">{activeJobs > 0 ? formatCount(activeJobs) + '개 작업 진행 중' : '미디어를 둘러보세요'}</span>
          </div>
        </div>
      </div>
    </aside>
  )
}
