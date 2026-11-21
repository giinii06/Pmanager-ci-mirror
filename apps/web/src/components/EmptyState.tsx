import type { ReactNode } from 'react'

interface EmptyStateProps {
  title: string
  body: string
  icon?: ReactNode
  action?: ReactNode
}

export function EmptyState({ title, body, icon, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-panel border border-dashed border-line bg-panel/50 px-6 py-20 text-center sm:py-24">
      {icon ? <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-[20px] bg-accent/10 text-accent">{icon}</div> : null}
      <h3 className="text-[18px] font-semibold tracking-tight text-ink">{title}</h3>
      <p className="mt-2 max-w-[430px] text-[14px] leading-relaxed text-muted">{body}</p>
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  )
}
