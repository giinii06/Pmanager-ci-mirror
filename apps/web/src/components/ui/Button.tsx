import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

const variants: Record<Variant, string> = {
  primary:
    'border border-transparent bg-accent text-[var(--ui-on-accent)] shadow-sm hover:bg-accent-strong active:scale-[0.985] font-semibold',
  secondary:
    'border border-line bg-panel text-ink shadow-sm hover:border-line-strong hover:bg-panel-2 active:scale-[0.985] font-medium',
  ghost: 'border border-transparent text-muted hover:bg-panel-2 hover:text-ink',
  danger: 'border border-danger/25 bg-danger/10 text-danger hover:bg-danger/15 font-medium',
}

const sizes: Record<Size, string> = {
  sm: 'min-h-9 px-3.5 text-[13px] gap-1.5',
  md: 'min-h-11 px-4.5 text-[14px] gap-2',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap rounded-xl transition-[background-color,border-color,color,transform] duration-150',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:pointer-events-none disabled:opacity-45',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  )
}
