import { lazy, Suspense } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { HoverPreview } from './HoverPreview'
import { Toasts } from './ui/Toasts'
import { useUi } from '../store/ui'

// hls.js only matters once the viewer opens, so keep it out of the first load.
const Lightbox = lazy(() =>
  import('./Lightbox').then((module) => ({ default: module.Lightbox })),
)

export function AppShell() {
  const sidebarOpen = useUi((state) => state.sidebarOpen)
  const setSidebarOpen = useUi((state) => state.setSidebarOpen)
  const journalOpen = useLocation().pathname.startsWith('/journal')

  return (
    <div className="flex h-full overflow-hidden bg-canvas">
      <Sidebar />
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
