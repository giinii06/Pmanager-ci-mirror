import type { InputHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-lg border border-line bg-panel-2 px-3 text-[13px] text-ink placeholder:text-faint',
        'transition-colors duration-150 hover:border-line-strong focus:border-accent/60 focus:outline-none',
        className,
      )}
      {...props}
    />
  )
}
