import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { HoverPreview } from './HoverPreview'
import { Toasts } from './ui/Toasts'
import { useUi } from '../store/ui'
import { useViewer } from '../store/viewer'
import { isMediaPath } from '../lib/mediaRoutes'

// hls.js only matters once the viewer opens, so keep it out of the first load.
const Lightbox = lazy(() =>
  import('./Lightbox').then((module) => ({ default: module.Lightbox })),
)

export function AppShell() {
  const sidebarOpen = useUi((state) => state.sidebarOpen)
  const setSidebarOpen = useUi((state) => state.setSidebarOpen)
  const sidebarCollapsed = useUi((state) => state.sidebarCollapsed)
  const [peekVisible, setPeekVisible] = useState(false)
  const peekTimer = useRef<number | null>(null)
  const pathname = useLocation().pathname
  const journalOpen = pathname.startsWith('/journal')

  useEffect(() => {
    if (!isMediaPath(pathname) && useViewer.getState().items.length) useViewer.getState().close()
  }, [pathname])

  useEffect(() => {
    if (sidebarCollapsed) return
    setPeekVisible(false)
    if (peekTimer.current !== null) window.clearTimeout(peekTimer.current)
    peekTimer.current = null
  }, [sidebarCollapsed])

  useEffect(() => () => {
    if (peekTimer.current !== null) window.clearTimeout(peekTimer.current)
  }, [])

  return (
    <div className="flex h-full overflow-hidden bg-canvas">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[90] focus:rounded-xl focus:bg-accent focus:px-4 focus:py-2 focus:font-semibold focus:text-[var(--ui-on-accent)]">본문으로 건너뛰기</a>
      <Sidebar peek={sidebarCollapsed && peekVisible} />
      {sidebarCollapsed ? (
        <div
          aria-hidden="true"
          className="fixed inset-y-0 left-0 z-40 hidden w-2 md:block"
          onPointerEnter={(event) => {
            if (event.pointerType === 'touch') return
            setPeekVisible(true)
            if (peekTimer.current !== null) window.clearTimeout(peekTimer.current)
            peekTimer.current = window.setTimeout(() => {
              setPeekVisible(false)
              peekTimer.current = null
            }, 3000)
          }}
        />
      ) : null}
      {sidebarOpen ? (
        <div
          className="fixed inset-0 z-40 bg-black/65 backdrop-blur-[3px] md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        {!journalOpen ? <Topbar /> : null}
        <main id="main-content" className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
      <Suspense fallback={null}>
        <Lightbox />
      </Suspense>
      <HoverPreview />
      <Toasts />
    </div>
  )
}
