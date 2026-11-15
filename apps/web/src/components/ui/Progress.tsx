import { cn } from '../../lib/cn'

type Size = 'row' | 'hero'
type Tone = 'accent' | 'muted'

export function Progress({
  value,
  size = 'row',
  tone = 'accent',
  label,
  className,
}: {
  /** 0–100. Null renders an indeterminate bar. */
  value: number | null
  size?: Size
  tone?: Tone
  label?: string
  className?: string
}) {
  const determinate = value !== null
  const percent = determinate ? Math.min(100, Math.max(0, value)) : null

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={percent ?? undefined}
      className={cn(
        'w-full overflow-hidden rounded-full bg-line',
        size === 'hero' ? 'h-2' : 'h-1.5',
        className,
      )}
    >
      {percent === null ? (
        <div
          className={cn(
            'h-full w-1/3 animate-[progress-slide_1.4s_ease-in-out_infinite] rounded-full',
            tone === 'accent' ? 'bg-accent' : 'bg-faint',
          )}
        />
      ) : (
        <div
          className={cn('h-full rounded-full', tone === 'accent' ? 'bg-accent' : 'bg-faint')}
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  )
}
