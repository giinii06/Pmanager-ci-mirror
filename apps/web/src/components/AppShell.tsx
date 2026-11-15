import { lazy, Suspense } from 'react'
import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { Toasts } from './ui/Toasts'
import { useUi } from '../store/ui'

// hls.js only matters once the viewer opens, so keep it out of the first load.
const Lightbox = lazy(() =>
  import('./Lightbox').then((module) => ({ default: module.Lightbox })),
)

export function AppShell() {
  const sidebarOpen = useUi((state) => state.sidebarOpen)
  const setSidebarOpen = useUi((state) => state.setSidebarOpen)

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar />
      {sidebarOpen ? (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[1px] md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
      <Suspense fallback={null}>
        <Lightbox />
      </Suspense>
      <Toasts />
    </div>
  )
}
