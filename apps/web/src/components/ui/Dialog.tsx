import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '../../lib/cn'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  className?: string
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const handleClose = () => onClose()
    element.addEventListener('close', handleClose)
    return () => element.removeEventListener('close', handleClose)
  }, [onClose])

  return (
    <dialog
      ref={ref}
      className={cn(
        'm-auto max-h-[85dvh] w-[min(540px,calc(100vw-32px))] overflow-y-auto rounded-[26px] border border-line bg-panel p-0 text-ink shadow-2xl',
        'backdrop:bg-black/65 backdrop:backdrop-blur-[2px]',
        'animate-rise',
        className,
      )}
      onClick={(event) => {
        if (event.target === ref.current) onClose()
      }}
    >
      <div className="flex items-start justify-between gap-5 border-b border-line px-6 py-5">
        <div>
          <h2 className="text-[19px] font-semibold tracking-tight">{title}</h2>
          {description ? <p className="mt-1 text-[13px] leading-relaxed text-muted">{description}</p> : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="닫기"
          className="-mr-2 rounded-xl p-2 text-muted transition-colors hover:bg-raised hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>
      <div className="px-6 py-5">{children}</div>
      {footer ? <div className="flex flex-wrap justify-end gap-2.5 border-t border-line px-6 py-4">{footer}</div> : null}
    </dialog>
  )
}
