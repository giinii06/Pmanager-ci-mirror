import type { ReactNode } from 'react'

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="mb-7 overflow-hidden rounded-panel border border-line bg-panel shadow-[var(--ui-elevation)]">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-5 py-4 sm:px-6 sm:py-5">
        <div className="min-w-0">
          <h2 className="text-[16px] font-semibold tracking-tight text-ink">{title}</h2>
          {description ? <p className="mt-1 text-[13px] leading-relaxed text-muted">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}

export function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-line bg-panel-2 px-4 py-3.5">
      <p className="text-[12px] font-medium text-muted">{label}</p>
      <p className="mt-1 text-[21px] font-semibold tabular-nums tracking-tight text-ink">{value}</p>
    </div>
  )
}
