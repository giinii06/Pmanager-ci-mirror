import { create } from 'zustand'

export type ToastTone = 'info' | 'success' | 'error'
export type ThemeMode = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

export interface Toast {
  id: number
  message: string
  tone: ToastTone
}

const SIDEBAR_COLLAPSED_KEY = 'mediavault.sidebarCollapsed'
const THEME_MODE_KEY = 'mediavault.themeMode'

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'dark' || mode === 'light') return mode
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'dark'
}

function loadThemeMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_MODE_KEY)
    if (raw === 'dark' || raw === 'light' || raw === 'system') return raw
  } catch {
    // Ignore storage restriction.
  }
  return 'system'
}

function applyThemeToDom(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode)
  if (typeof document !== 'undefined') {
    const root = document.documentElement
    root.dataset.theme = resolved
    root.dataset.themeMode = mode
    root.style.colorScheme = resolved
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0B0C0F' : '#F6F7F4')
  }
  return resolved
}

interface UiState {
  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
  sidebarCollapsed: boolean
  toggleSidebarCollapsed: () => void
  themeMode: ThemeMode
  resolvedTheme: ResolvedTheme
  setThemeMode: (mode: ThemeMode) => void
  toasts: Toast[]
  toast: (message: string, tone?: ToastTone) => void
  dismiss: (id: number) => void
}

let nextToast = 1
const initialThemeMode = loadThemeMode()
const initialResolved = applyThemeToDom(initialThemeMode)

export const useUi = create<UiState>((set) => ({
  sidebarOpen: false,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  sidebarCollapsed: loadCollapsed(),
  toggleSidebarCollapsed: () =>
    set((state) => {
      const next = !state.sidebarCollapsed
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0')
      } catch {
        // Ignore blocked storage in private browsing.
      }
      return { sidebarCollapsed: next }
    }),
  themeMode: initialThemeMode,
  resolvedTheme: initialResolved,
  setThemeMode: (mode) => {
    try {
      localStorage.setItem(THEME_MODE_KEY, mode)
    } catch {
      // Ignore blocked storage.
    }
    const resolved = applyThemeToDom(mode)
    set({ themeMode: mode, resolvedTheme: resolved })
  },
  toasts: [],
  toast: (message, tone = 'info') => {
    const id = nextToast
    nextToast += 1
    set((state) => ({ toasts: [...state.toasts, { id, message, tone }] }))
    window.setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
    }, 3800)
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}))

if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const handleOsThemeChange = () => {
    const current = useUi.getState()
    if (current.themeMode === 'system') {
      const resolved = applyThemeToDom('system')
      useUi.setState({ resolvedTheme: resolved })
    }
  }
  mq.addEventListener?.('change', handleOsThemeChange)
}
