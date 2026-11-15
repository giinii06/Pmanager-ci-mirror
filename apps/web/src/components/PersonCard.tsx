import { UserRound } from 'lucide-react'
import type { PersonDTO } from '@mediavault/shared'
import { cn } from '../lib/cn'
import { formatCount } from '../lib/format'

export function PersonCard({
  person,
  selected,
  onOpen,
}: {
  person: PersonDTO
  selected: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group flex flex-col overflow-hidden rounded-xl border bg-panel/60 text-left transition-colors',
        selected ? 'border-accent/60' : 'border-line/70 hover:border-line hover:bg-raised/60',
      )}
    >
      <span className="relative block aspect-square w-full overflow-hidden bg-raised">
        {person.coverUrl ? (
          <img
            src={person.coverUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-faint">
            <UserRound size={28} />
          </span>
        )}
        <span className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
      </span>
      <span className="flex items-center gap-2 px-2.5 py-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
          {person.name}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-faint">
          {formatCount(person.assetCount)}개 영상
        </span>
      </span>
    </button>
  )
}
