import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export function IconButton({
  label,
  onClick,
  children,
  active,
}: {
  label: string
  onClick: () => void
  children: ReactNode
  active?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'rounded-full p-2 transition-colors',
        active
          ? 'bg-accent/15 text-accent'
          : 'text-muted hover:bg-raised hover:text-ink',
      )}
    >
      {children}
    </button>
  )
}
