import type { InputHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'min-h-11 w-full rounded-xl border border-line bg-canvas px-3.5 text-[14px] text-ink shadow-sm placeholder:text-faint',
        'transition-[background-color,border-color,box-shadow] duration-150 hover:border-line-strong',
        'focus:border-accent/65 focus:outline-none focus:ring-3 focus:ring-accent/10',
        className,
      )}
      {...props}
    />
  )
}
