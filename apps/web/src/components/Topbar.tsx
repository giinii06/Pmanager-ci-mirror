import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bell, Menu, PanelLeft, Search, Settings2 } from 'lucide-react'
import { api } from '../lib/api'
import { useDebounced } from '../lib/hooks'
import { useUi } from '../store/ui'

function sectionName(pathname: string): string {
  if (pathname.startsWith('/videos/tags')) return '영상 태그'
  if (pathname.startsWith('/videos')) return '동영상'
  if (pathname.startsWith('/folders')) return '사진 모음'
  if (pathname.startsWith('/duplicates')) return '중복 검토'
  if (pathname.startsWith('/notifications')) return '알림'
  if (pathname.startsWith('/settings')) return '설정'
  if (pathname.startsWith('/search')) return '검색 결과'
  return '사진'
}

export function Topbar() {
  const navigate = useNavigate()
  const location = useLocation()
  const setSidebarOpen = useUi((state) => state.setSidebarOpen)
  const toggleSidebarCollapsed = useUi((state) => state.toggleSidebarCollapsed)
  const [value, setValue] = useState(() => {
    if (typeof window === 'undefined') return ''
    return new URLSearchParams(window.location.search).get('q') ?? ''
  })
  const inputRef = useRef<HTMLInputElement>(null)
  const debounced = useDebounced(value, 260)
  const capabilities = useQuery({
    queryKey: ['capabilities'], queryFn: api.capabilities, staleTime: 60_000, retry: false,
  })
  const notificationsOn = capabilities.data?.notifications === true
  const unread = useQuery({
    queryKey: ['notifications', 'unread'], queryFn: api.notificationsUnread,
    enabled: notificationsOn, refetchInterval: 30_000, retry: false,
  })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (location.pathname !== '/search') setValue('')
  }, [location.pathname])

  useEffect(() => {
    const trimmed = debounced.trim()
    if (trimmed.length >= 2) {
      const next = '/search?q=' + encodeURIComponent(trimmed)
      const current = location.pathname + location.search
      if (current !== next) navigate(next, { replace: location.pathname === '/search' })
      return
    }
    if (trimmed.length === 0 && location.pathname === '/search') {
      navigate('/', { replace: true })
    }
  }, [debounced, location.pathname, location.search, navigate])

  return (
    <header className="flex h-[76px] shrink-0 items-center gap-3 border-b border-line bg-canvas/90 px-4 backdrop-blur-md sm:px-6 lg:px-9">
      <button
        type="button"
        onClick={() => setSidebarOpen(true)}
        aria-label="메뉴 열기"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-panel-2 hover:text-ink md:hidden"
      >
        <Menu size={21} />
      </button>
      <button
        type="button"
        onClick={toggleSidebarCollapsed}
        aria-label="사이드바 토글"
        title="사이드바 접기/펼치기"
        className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-panel-2 hover:text-ink md:inline-flex"
      >
        <PanelLeft size={20} />
      </button>
      <div className="hidden min-w-[95px] flex-col lg:flex">
        <span className="text-[11px] font-medium text-faint">라이브러리</span>
        <span className="text-[14px] font-semibold text-ink">{sectionName(location.pathname)}</span>
      </div>
      <div className="relative mx-auto w-full max-w-[560px]">
        <Search size={19} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-faint" />
        <input
          ref={inputRef}
          aria-label="미디어 검색"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              const trimmed = value.trim()
              if (trimmed.length >= 1) navigate('/search?q=' + encodeURIComponent(trimmed))
            }
            if (event.key === 'Escape') {
              setValue('')
              if (location.pathname === '/search') navigate('/')
            }
          }}
          placeholder="사진, 영상, 장면, 대사 검색"
          className="h-11 w-full rounded-2xl border border-line bg-panel pl-11 pr-14 text-[14px] text-ink shadow-sm outline-none placeholder:text-faint transition-[border-color,box-shadow] hover:border-line-strong focus:border-accent/60 focus:ring-3 focus:ring-accent/10"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-lg border border-line bg-panel-2 px-2 py-1 text-[11px] font-medium text-faint sm:inline">
          ⌘K
        </span>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {notificationsOn ? (
          <button
            type="button"
            onClick={() => navigate('/notifications')}
            aria-label={unread.data && unread.data.unread > 0 ? '알림, 읽지 않음 ' + unread.data.unread + '개' : '알림'}
            className="relative flex h-11 w-11 items-center justify-center rounded-xl text-muted hover:bg-panel-2 hover:text-ink"
          >
            <Bell size={20} />
            {unread.data && unread.data.unread > 0 ? (
              <span className="absolute right-1 top-1 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold leading-none text-white">
                {unread.data.unread > 99 ? '99+' : unread.data.unread}
              </span>
            ) : null}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => navigate('/settings')}
          aria-label="설정"
          className="flex h-11 w-11 items-center justify-center rounded-xl text-muted hover:bg-panel-2 hover:text-ink"
        >
          <Settings2 size={20} />
        </button>
      </div>
    </header>
  )
}
