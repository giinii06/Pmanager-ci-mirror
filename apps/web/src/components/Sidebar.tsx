import { useEffect } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Aperture,
  Copy,
  Film,
  FolderHeart,
  Images,
  Layers,
  ListVideo,
  Loader2,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
  Sun,
  Tag,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { formatCount } from '../lib/format'
import { useUi, type ThemeMode } from '../store/ui'

export function Sidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const sidebarOpen = useUi((state) => state.sidebarOpen)
  const setSidebarOpen = useUi((state) => state.setSidebarOpen)
  const collapsed = useUi((state) => state.sidebarCollapsed)
  const toggleCollapsed = useUi((state) => state.toggleSidebarCollapsed)
  const themeMode = useUi((state) => state.themeMode)
  const setThemeMode = useUi((state) => state.setThemeMode)

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
  const inBulk = location.pathname.startsWith('/bulk')
  const inSmartAlbums = location.pathname.startsWith('/smart-albums')
  const inPlaylists = location.pathname.startsWith('/playlists')

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

      <nav className="flex-1 space-y-1 px-2.5 pt-1" aria-label="주 메뉴">
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

        <NavLink
          to="/bulk"
          title="일괄 작업"
          className={() =>
            cn(
              'flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors',
              collapsed && 'md:justify-center md:px-0',
              inBulk
                ? 'bg-accent/12 text-accent'
                : 'text-muted hover:bg-raised/70 hover:text-ink',
            )
          }
        >
          <Layers size={16} className={inBulk ? 'text-accent' : 'text-faint'} />
          <span className={cn('flex-1', collapsed && 'md:hidden')}>일괄 작업</span>
        </NavLink>

        <NavLink
          to="/smart-albums"
          title="스마트 앨범"
          className={() =>
            cn(
              'flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors',
              collapsed && 'md:justify-center md:px-0',
              inSmartAlbums
                ? 'bg-accent/12 text-accent'
                : 'text-muted hover:bg-raised/70 hover:text-ink',
            )
          }
        >
          <FolderHeart size={16} className={inSmartAlbums ? 'text-accent' : 'text-faint'} />
          <span className={cn('flex-1', collapsed && 'md:hidden')}>스마트 앨범</span>
        </NavLink>

        <NavLink
          to="/playlists"
          title="재생목록"
          className={() =>
            cn(
              'flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors',
              collapsed && 'md:justify-center md:px-0',
              inPlaylists
                ? 'bg-accent/12 text-accent'
                : 'text-muted hover:bg-raised/70 hover:text-ink',
            )
          }
        >
          <ListVideo size={16} className={inPlaylists ? 'text-accent' : 'text-faint'} />
          <span className={cn('flex-1', collapsed && 'md:hidden')}>재생목록</span>
        </NavLink>

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

      <div className="space-y-2 border-t border-line px-3 py-2.5">
        <div
          className={cn(
            'flex items-center gap-1 rounded-lg border border-line bg-panel-2 p-0.5',
            collapsed && 'md:flex-col',
          )}
          role="group"
          aria-label="테마 선택"
        >
          {(
            [
              { id: 'dark', label: '다크', Icon: Moon },
              { id: 'light', label: '라이트', Icon: Sun },
              { id: 'system', label: '시스템', Icon: Monitor },
            ] as Array<{ id: ThemeMode; label: string; Icon: typeof Moon }>
          ).map(({ id, label, Icon }) => {
            const active = themeMode === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => setThemeMode(id)}
                title={`${label} 테마`}
                aria-pressed={active}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1 rounded-md py-1 text-[11px] font-medium transition-colors',
                  collapsed && 'md:w-full md:px-0',
                  active
                    ? 'bg-panel text-ink shadow-xs'
                    : 'text-faint hover:text-ink',
                )}
              >
                <Icon size={12} />
                <span className={cn(collapsed && 'md:hidden')}>{label}</span>
              </button>
            )
          })}
        </div>

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
