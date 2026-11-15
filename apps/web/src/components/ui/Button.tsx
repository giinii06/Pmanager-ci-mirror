import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

const variants: Record<Variant, string> = {
  primary:
    'bg-accent text-[#0b0c0f] hover:bg-accent-strong active:translate-y-px font-semibold shadow-[0_1px_0_rgba(255,255,255,0.2)_inset]',
  secondary:
    'bg-raised text-ink border border-line-strong hover:bg-[#242832] hover:border-[#3a3f4b] active:translate-y-px',
  ghost: 'text-muted hover:text-ink hover:bg-raised',
  danger: 'bg-transparent text-danger border border-[#4a2a2e] hover:bg-[#2a1719]',
}

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] rounded-lg gap-1.5',
  md: 'h-9 px-4 text-[13px] rounded-lg gap-2',
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
        'inline-flex select-none items-center justify-center whitespace-nowrap transition-colors duration-150 disabled:pointer-events-none disabled:opacity-45',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  )
}
