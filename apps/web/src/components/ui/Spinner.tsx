import { Loader2 } from 'lucide-react'
import { cn } from '../../lib/cn'

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('animate-spin text-muted', className)} size={18} />
}

export function LoadingBlock({ label = '불러오는 중' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-24 text-[13px] text-muted">
      <Spinner />
      {label}
    </div>
  )
}
