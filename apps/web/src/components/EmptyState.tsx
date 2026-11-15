import type { ReactNode } from 'react'
import { ImageOff } from 'lucide-react'

interface EmptyStateProps {
  title: string
  body: string
  icon?: ReactNode
  action?: ReactNode
}

export function EmptyState({ title, body, icon, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-panel border border-dashed border-line px-6 py-20 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-panel-2 text-muted">
        {icon ?? <ImageOff size={20} />}
      </div>
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 max-w-[380px] text-[13px] leading-relaxed text-muted">{body}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}
