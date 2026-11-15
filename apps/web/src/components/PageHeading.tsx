import type { ReactNode } from 'react'

interface PageHeadingProps {
  title: string
  meta?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}

export function PageHeading({ title, meta, actions, children }: PageHeadingProps) {
  return (
    <header className="pb-4 pt-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-[26px] font-semibold leading-tight tracking-tight text-ink">
            {title}
          </h1>
          {meta ? <div className="mt-1 text-[12.5px] text-muted">{meta}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </header>
  )
}
