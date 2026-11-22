import { cn } from '../lib/cn'

export function BrandLogo({ className }: { className?: string }) {
  return (
    <img
      src="/poda-icon.png"
      alt=""
      aria-hidden="true"
      width={160}
      height={160}
      decoding="async"
      className={cn('block shrink-0 rounded-full object-contain', className)}
    />
  )
}
