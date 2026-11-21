import type { ReactNode } from 'react'

interface PageHeadingProps {
  title: string
  meta?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}

export function PageHeading({ title, meta, actions, children }: PageHeadingProps) {
  return (
    <header className="pb-6 pt-7 sm:pb-7 sm:pt-9">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="min-w-0 break-words text-[clamp(28px,3.1vw,40px)] font-bold leading-[1.18] tracking-tight text-ink">
            {title}
          </h1>
          {meta ? <div className="mt-2 text-[14px] text-muted">{meta}</div> : null}
        </div>
        {actions ? <div className="flex min-w-0 flex-wrap items-center gap-2.5">{actions}</div> : null}
      </div>
      {children}
    </header>
  )
}
