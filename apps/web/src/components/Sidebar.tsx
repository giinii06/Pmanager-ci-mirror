import { useEffect } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Aperture,
  Copy,
  Film,
  Images,
  BookOpenText,
  Plus,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
  Tag,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { formatCount } from '../lib/format'
import { useUi } from '../store/ui'

export function Sidebar() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const location = useLocation()
  const sidebarOpen = useUi((state) => state.sidebarOpen)
  const setSidebarOpen = useUi((state) => state.setSidebarOpen)
  const collapsed = useUi((state) => state.sidebarCollapsed)
  const toggleCollapsed = useUi((state) => state.toggleSidebarCollapsed)

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
  const inPhotos = location.pathname === '/' || location.pathname.startsWith('/folders')
  const inVideos = location.pathname.startsWith('/videos')
  const inDuplicates = location.pathname.startsWith('/duplicates')
  const inJournal = location.pathname.startsWith('/journal')
  const journal = useQuery({
    queryKey: ['journal', 'recent'],
    queryFn: () => api.journalEntries(),
    enabled: inJournal,
  })
  const createJournal = useMutation({
    mutationFn: api.createJournalEntry,
    onSuccess: (entry) => {
      void queryClient.invalidateQueries({ queryKey: ['journal'] })
      navigate(`/journal/${entry.id}`)
    },
    onError: () => toast('새 일지를 만들지 못했습니다.', 'error'),
  })

  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-50 flex shrink-0 flex-col border-r border-line bg-panel transition-[transform,width] duration-200 md:static md:translate-x-0',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        'w-[232px]',
        collapsed && 'md:w-[64px]',
      )}
    >
      <div
        className={cn(
          'flex h-14 items-center px-3.5',
          collapsed ? 'md:justify-center md:px-2' : 'justify-between',
        )}
      >
        <button
          type="button"
          onClick={() => navigate('/')}
          title="MediaVault"
          className="flex items-center gap-2.5 rounded-lg text-left"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Aperture size={16} />
          </span>
          <span
            className={cn(
              'text-[14px] font-semibold tracking-tight text-ink',
              collapsed && 'md:hidden',
            )}
          >
            MediaVault
          </span>
        </button>

        {!collapsed ? (
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label="사이드바 접기"
            title="사이드바 접기"
            className="hidden rounded-md p-1.5 text-faint hover:bg-raised hover:text-ink md:inline-flex"
          >
            <PanelLeftClose size={15} />
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => setSidebarOpen(false)}
          className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-ink md:hidden"
          aria-label="메뉴 닫기"
        >
          <X size={16} />
        </button>
      </div>

      {collapsed ? (
        <div className="hidden justify-center pb-2 md:flex">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label="사이드바 펼치기"
            title="사이드바 펼치기"
            className="rounded-md p-1.5 text-faint hover:bg-raised hover:text-ink"
          >
            <PanelLeftOpen size={15} />
          </button>
        </div>
      ) : null}

      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2.5 pb-3 pt-1" aria-label="주 메뉴">
        <NavLink
          to="/"
          end
          title="사진"
          className={() =>
            cn(
              'flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors',
              collapsed && 'md:justify-center md:px-0',
              inPhotos
                ? 'bg-accent/12 text-accent'
                : 'text-muted hover:bg-raised/70 hover:text-ink',
            )
          }
        >
          <Images size={16} className={inPhotos ? 'text-accent' : 'text-faint'} />
          <span className={cn('flex-1', collapsed && 'md:hidden')}>사진</span>
          {typeof stats.data?.images === 'number' && stats.data.images > 0 ? (
            <span className={cn('text-[10.5px] tabular-nums text-faint', collapsed && 'md:hidden')}>
              {formatCount(stats.data.images)}
            </span>
          ) : null}
        </NavLink>

        <div>
          <NavLink
            to="/videos"
            title="동영상"
            className={() =>
              cn(
                'flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors',
                collapsed && 'md:justify-center md:px-0',
                inVideos
                  ? 'bg-accent/12 text-accent'
                  : 'text-muted hover:bg-raised/70 hover:text-ink',
              )
            }
          >
            <Film size={16} className={inVideos ? 'text-accent' : 'text-faint'} />
            <span className={cn('flex-1', collapsed && 'md:hidden')}>동영상</span>
            {typeof stats.data?.videos === 'number' && stats.data.videos > 0 ? (
              <span className={cn('text-[10.5px] tabular-nums text-faint', collapsed && 'md:hidden')}>
                {formatCount(stats.data.videos)}
              </span>
            ) : null}
          </NavLink>

          <div className={cn('mt-0.5 space-y-0.5 pl-6 pr-1', collapsed && 'md:hidden')}>
            <NavLink
              to="/videos"
              end
              className={({ isActive }) =>
                cn(
                  'flex h-7 items-center gap-2 rounded-md px-2 text-[12px] transition-colors',
                  isActive
                    ? 'bg-raised text-ink font-medium'
                    : 'text-muted hover:bg-raised/60 hover:text-ink',
                )
              }
            >
              <span>전체 보기</span>
            </NavLink>
            <NavLink
              to="/videos/tags"
              className={({ isActive }) =>
                cn(
                  'flex h-7 items-center gap-2 rounded-md px-2 text-[12px] transition-colors',
                  isActive
                    ? 'bg-raised text-ink font-medium'
                    : 'text-muted hover:bg-raised/60 hover:text-ink',
                )
              }
            >
              <Tag size={12} className="text-faint" />
              <span>태그별 보기</span>
            </NavLink>
          </div>
        </div>

        <NavLink
          to="/duplicates"
          title="중복 검토"
          className={() =>
            cn(
              'flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors',
              collapsed && 'md:justify-center md:px-0',
              inDuplicates
                ? 'bg-accent/12 text-accent'
                : 'text-muted hover:bg-raised/70 hover:text-ink',
            )
          }
        >
          <Copy size={16} className={inDuplicates ? 'text-accent' : 'text-faint'} />
          <span className={cn('flex-1', collapsed && 'md:hidden')}>중복 검토</span>
        </NavLink>

        <div>
          <div className="flex items-center gap-0.5">
            <NavLink
              to="/journal"
              title="일지"
              className={() =>
                cn(
                  'flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors',
                  collapsed && 'md:justify-center md:px-0',
                  inJournal ? 'bg-accent/12 text-accent' : 'text-muted hover:bg-raised/70 hover:text-ink',
                )
              }
            >
              <BookOpenText size={16} className={inJournal ? 'text-accent' : 'text-faint'} />
              <span className={cn('flex-1', collapsed && 'md:hidden')}>일지</span>
            </NavLink>
            <button
              type="button"
              aria-label="새 일지 만들기"
              title="새 일지 만들기"
              disabled={createJournal.isPending}
              onClick={() => createJournal.mutate()}
              className={cn(
                'rounded-md p-1.5 text-faint hover:bg-raised hover:text-ink disabled:opacity-40',
                collapsed && 'md:hidden',
              )}
            >
              {createJournal.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            </button>
          </div>
          {inJournal && !collapsed && journal.data?.items.length ? (
            <div className="mt-1 space-y-0.5 pl-6 pr-1 md:block">
              {journal.data.items.slice(0, 12).map((entry) => (
                <NavLink
                  key={entry.id}
                  to={`/journal/${entry.id}`}
                  className={({ isActive }) =>
                    cn(
                      'block truncate rounded-md px-2 py-1 text-[12px] transition-colors',
                      isActive ? 'bg-raised font-medium text-ink' : 'text-muted hover:bg-raised/60 hover:text-ink',
                    )
                  }
                  title={entry.title || '제목 없음'}
                >
                  <span className="mr-1.5 text-faint">
                    {new Date(entry.createdAt).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}
                  </span>
                  {entry.title || '제목 없음'}
                </NavLink>
              ))}
            </div>
          ) : null}
        </div>

        <NavLink
          to="/settings"
          title="설정"
          className={({ isActive }) =>
            cn(
              'flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors',
              collapsed && 'md:justify-center md:px-0',
              isActive
                ? 'bg-accent/12 text-accent'
                : 'text-muted hover:bg-raised/70 hover:text-ink',
            )
          }
        >
          {({ isActive }) => (
            <>
              <Settings2 size={16} className={isActive ? 'text-accent' : 'text-faint'} />
              <span className={cn('flex-1', collapsed && 'md:hidden')}>설정</span>
            </>
          )}
        </NavLink>
      </nav>

      <div className="border-t border-line px-3 py-2.5">
        <div
          className={cn(
            'flex items-center gap-2 text-[11.5px] text-muted',
            collapsed && 'md:justify-center',
          )}
        >
          {activeJobs > 0 ? (
            <>
              <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
              <span className={cn(collapsed && 'md:hidden')}>
                {formatCount(activeJobs)}개 작업 처리 중
              </span>
            </>
          ) : (
            <>
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#4ade80]/70" />
              <span className={cn(collapsed && 'md:hidden')}>준비됨</span>
            </>
          )}
        </div>
      </div>
    </aside>
  )
}
