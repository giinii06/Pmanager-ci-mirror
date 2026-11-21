import { CheckCircle2, Info, XCircle } from 'lucide-react'
import { useUi } from '../../store/ui'
import { cn } from '../../lib/cn'

export function Toasts() {
  const toasts = useUi((state) => state.toasts)
  const dismiss = useUi((state) => state.dismiss)

  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-[80] flex w-[min(390px,calc(100vw-32px))] flex-col gap-2">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => dismiss(toast.id)}
          className={cn(
            'pointer-events-auto flex items-start gap-3 rounded-2xl border px-4 py-3.5 text-left text-[14px] shadow-[var(--ui-elevation-hover)] backdrop-blur',
            'animate-rise',
            toast.tone === 'error'
              ? 'border-danger/35 bg-panel/95 text-danger'
              : toast.tone === 'success'
                ? 'border-emerald-500/35 bg-panel/95 text-emerald-500'
                : 'border-line-strong bg-panel/95 text-ink',
          )}
        >
          {toast.tone === 'error' ? (
            <XCircle size={16} className="mt-0.5 shrink-0" />
          ) : toast.tone === 'success' ? (
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          ) : (
            <Info size={16} className="mt-0.5 shrink-0" />
          )}
          <span className="leading-snug">{toast.message}</span>
        </button>
      ))}
    </div>
  )
}
