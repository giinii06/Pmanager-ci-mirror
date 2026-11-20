import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bell, Menu, PanelLeft, Search, Settings2 } from 'lucide-react'
import { api } from '../lib/api'
import { useDebounced } from '../lib/hooks'
import { useUi } from '../store/ui'

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
    queryKey: ['capabilities'],
    queryFn: api.capabilities,
    staleTime: 60_000,
    retry: false,
  })
  const notificationsOn = capabilities.data?.notifications === true
  const unread = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: api.notificationsUnread,
    enabled: notificationsOn,
    refetchInterval: 30_000,
    retry: false,
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
      const next = `/search?q=${encodeURIComponent(trimmed)}`
      const current = `${location.pathname}${location.search}`
      if (current !== next) navigate(next, { replace: location.pathname === '/search' })
      return
    }
    if (trimmed.length === 0 && location.pathname === '/search') {
      navigate('/', { replace: true })
    }
  }, [debounced, location.pathname, location.search, navigate])

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-canvas/85 px-3 backdrop-blur-md sm:px-6">
      <button
        type="button"
        onClick={() => setSidebarOpen(true)}
        aria-label="메뉴 열기"
        className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-ink md:hidden"
      >
        <Menu size={18} />
      </button>
      <button
        type="button"
        onClick={toggleSidebarCollapsed}
        aria-label="사이드바 토글"
        title="사이드바 접기/펼치기"
        className="hidden rounded-md p-1.5 text-muted hover:bg-raised hover:text-ink md:inline-flex"
      >
        <PanelLeft size={16} />
      </button>

      <div className="relative w-full max-w-[380px]">
        <Search
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
        />
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              const trimmed = value.trim()
              if (trimmed.length >= 1) navigate(`/search?q=${encodeURIComponent(trimmed)}`)
            }
            if (event.key === 'Escape') {
              setValue('')
              if (location.pathname === '/search') navigate('/')
            }
          }}
          placeholder="장면, 대사, 파일 이름 검색"
          className="h-8 w-full rounded-lg border border-line bg-panel-2 pl-8 pr-14 text-[12.5px] text-ink placeholder:text-faint transition-colors hover:border-line-strong focus:border-accent/50 focus:outline-none"
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-line px-1.5 py-0.5 text-[10px] text-faint">
          ⌘K
        </span>
      </div>

      <div className="ml-auto flex items-center gap-1">
        {notificationsOn ? (
          <button
            type="button"
            onClick={() => navigate('/notifications')}
            aria-label={
              unread.data && unread.data.unread > 0
                ? `알림, 읽지 않음 ${unread.data.unread}개`
                : '알림'
            }
            className="relative rounded-lg p-2 text-muted transition-colors hover:bg-raised hover:text-ink"
          >
            <Bell size={16} />
            {unread.data && unread.data.unread > 0 ? (
              <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9.5px] font-semibold leading-none text-white">
                {unread.data.unread > 99 ? '99+' : unread.data.unread}
              </span>
            ) : null}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => navigate('/settings')}
          aria-label="설정"
          className="rounded-lg p-2 text-muted transition-colors hover:bg-raised hover:text-ink"
        >
          <Settings2 size={16} />
        </button>
      </div>
    </header>
  )
}
