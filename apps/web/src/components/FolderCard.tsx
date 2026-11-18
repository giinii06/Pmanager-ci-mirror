import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Eye, Folder as FolderIcon, Info, Percent, ThumbsUp } from 'lucide-react'
import { POSTER_SCHEME, type FolderDTO } from '@mediavault/shared'
import { cn } from '../lib/cn'
import { formatCount, formatRate } from '../lib/format'
import { Thumb } from './Thumb'

export function FolderCard({
  folder,
  count,
  onVote,
}: {
  folder: FolderDTO
  count?: number
  onVote?: (folderId: string) => void
}) {
  const [infoOpen, setInfoOpen] = useState(false)
  const photoCount = count ?? folder.assetCount
  const aspectW = folder.coverWidth && folder.coverWidth > 0 ? folder.coverWidth : 4
  const aspectH = folder.coverHeight && folder.coverHeight > 0 ? folder.coverHeight : 3
  const clampedRatio = Math.min(2.4, Math.max(0.45, aspectW / aspectH))
  const coverSrc = folder.coverAssetId
    ? `/api/assets/${folder.coverAssetId}/thumbnail?size=640&v=${folder.coverFileVersion}&pv=${folder.coverPosterVersion}&p=${POSTER_SCHEME}`
    : null

  return (
    <div className="group relative mb-3 break-inside-avoid overflow-hidden rounded-panel border border-line bg-panel transition-colors duration-150 hover:border-line-strong">
      <Link
        to={`/folders/${folder.id}`}
        aria-label={`${folder.name} (${formatCount(photoCount)}장)`}
        className="block focus-visible:outline-none"
      >
        <div
          className="relative w-full overflow-hidden bg-panel-2"
          style={{ aspectRatio: String(clampedRatio) }}
        >
          {coverSrc ? (
            <Thumb
              src={coverSrc}
              alt={folder.name}
              fit="contain"
              className="h-full w-full"
              imageClassName="transition-transform duration-500 ease-out group-hover:scale-[1.025]"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-faint">
              <FolderIcon size={28} strokeWidth={1.4} />
            </div>
          )}

          <div
            className={cn(
              'pointer-events-none absolute inset-0 flex max-h-full flex-col justify-end overflow-y-auto bg-gradient-to-t from-black/85 via-black/45 to-black/10 p-3 transition-opacity duration-200',
              infoOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
            )}
          >
            <p className="truncate text-[13.5px] font-semibold tracking-tight text-white">
              {folder.name}
            </p>
            <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] tabular-nums text-white/85">
              <div className="flex items-center justify-between gap-1">
                <dt className="text-white/65">사진</dt>
                <dd className="font-medium">{formatCount(photoCount)}개</dd>
              </div>
              <div className="flex items-center justify-between gap-1">
                <dt className="flex items-center gap-0.5 text-white/65">
                  <Percent size={10} />
                  Rate
                </dt>
                <dd className="font-medium text-[#fdba74]">{formatRate(folder.rate)}</dd>
              </div>
              <div className="flex items-center justify-between gap-1">
                <dt className="flex items-center gap-0.5 text-white/65">
                  <ThumbsUp size={10} />
                  Vote
                </dt>
                <dd className="font-medium">{formatCount(folder.voteCount)}</dd>
              </div>
              <div className="flex items-center justify-between gap-1">
                <dt className="flex items-center gap-0.5 text-white/65">
                  <Eye size={10} />
                  조회
                </dt>
                <dd className="font-medium">{formatCount(folder.viewCount)}</dd>
              </div>
            </dl>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <p className="min-w-0 truncate text-[12.5px] font-medium text-ink">{folder.name}</p>
          <span className="shrink-0 text-[11px] tabular-nums text-faint">
            {formatCount(photoCount)}
          </span>
        </div>
      </Link>

      <div className="absolute right-2 top-2 z-10 flex items-center gap-1.5">
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setInfoOpen((open) => !open)
          }}
          aria-label={`${folder.name} 정보 보기`}
          aria-pressed={infoOpen}
          className={cn(
            'inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white/90 backdrop-blur-sm transition-colors hover:bg-black/80',
            infoOpen && 'bg-accent text-white',
          )}
        >
          <Info size={12} />
        </button>
        {onVote ? (
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onVote(folder.id)
            }}
            aria-label={`${folder.name} 폴더 Vote (${formatCount(folder.voteCount)})`}
            className="inline-flex h-7 items-center gap-1 rounded-full bg-black/55 px-2 text-[11px] font-medium tabular-nums text-white backdrop-blur-sm transition-colors hover:bg-[#f97316]"
          >
            <ThumbsUp size={11} />
            <span>{formatCount(folder.voteCount)}</span>
          </button>
        ) : null}
      </div>
    </div>
  )
}
