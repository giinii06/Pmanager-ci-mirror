import { CheckCircle2, Info, XCircle } from 'lucide-react'
import { useUi } from '../../store/ui'
import { cn } from '../../lib/cn'

export function Toasts() {
  const toasts = useUi((state) => state.toasts)
  const dismiss = useUi((state) => state.dismiss)

  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[80] flex w-[min(360px,calc(100vw-40px))] flex-col gap-2">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => dismiss(toast.id)}
          className={cn(
            'pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-left text-[13px] shadow-xl backdrop-blur',
            'animate-rise',
            toast.tone === 'error'
              ? 'border-[#4a2a2e] bg-[#241518]/95 text-[#ffc9c9]'
              : toast.tone === 'success'
                ? 'border-[#24402f] bg-[#12211a]/95 text-[#b9f0cf]'
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
