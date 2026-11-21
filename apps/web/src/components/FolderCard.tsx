import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Eye, Folder as FolderIcon, Info, Percent, ThumbsUp } from 'lucide-react'
import { POSTER_SCHEME, type FolderDTO } from '@mediavault/shared'
import { cn } from '../lib/cn'
import { clampedCoverAspectRatio } from '../lib/folderLayout'
import { formatCount, formatRate } from '../lib/format'
import { Thumb } from './Thumb'

export function FolderCard({
  folder,
  count,
  width,
  imageHeight,
  priority = false,
  onVote,
}: {
  folder: FolderDTO
  count?: number
  width?: number
  imageHeight?: number
  priority?: boolean
  onVote?: (folderId: string) => void
}) {
  const [infoOpen, setInfoOpen] = useState(false)
  const photoCount = count ?? folder.assetCount
  const cover = folder.coverAssetId
    ? (() => {
        const versionSuffix = `v=${folder.coverFileVersion}&pv=${folder.coverPosterVersion}&p=${POSTER_SCHEME}`
        const small = `/api/assets/${folder.coverAssetId}/thumbnail?size=320&${versionSuffix}`
        const medium = `/api/assets/${folder.coverAssetId}/thumbnail?size=640&${versionSuffix}`
        return { src: medium, srcSet: `${small} 320w, ${medium} 640w` }
      })()
    : null
  const coverSizes = width
    ? `${Math.round(width)}px`
    : '(min-width: 960px) 25vw, (min-width: 600px) 33vw, 50vw'

  return (
    <div className="group relative overflow-hidden rounded-panel border border-line bg-panel shadow-[var(--ui-elevation)] transition-[border-color,box-shadow] duration-200 hover:border-line-strong hover:shadow-[var(--ui-elevation-hover)]">
      <Link
        to={`/folders/${folder.id}`}
        aria-label={`${folder.name} (${formatCount(photoCount)}장)`}
        className="block focus-visible:outline-none"
      >
        <div
          className="relative w-full overflow-hidden bg-panel-2"
          style={
            imageHeight !== undefined
              ? { height: imageHeight }
              : { aspectRatio: String(clampedCoverAspectRatio(folder.coverWidth, folder.coverHeight)) }
          }
        >
          {cover ? (
            <Thumb
              src={cover.src}
              srcSet={cover.srcSet}
              sizes={coverSizes}
              alt={folder.name}
              fit="contain"
              priority={priority}
              className="h-full w-full"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-faint">
              <FolderIcon size={28} strokeWidth={1.4} />
            </div>
          )}

          <div
            className={cn(
              'pointer-events-none absolute inset-0 flex flex-col justify-end overflow-hidden bg-gradient-to-t from-black/85 via-black/45 to-black/10 p-3 transition-opacity duration-150',
              infoOpen
                ? 'opacity-100'
                : 'opacity-0 [@media(hover:hover)]:group-hover:opacity-100 group-focus-within:opacity-100',
            )}
          >
            <p className="truncate text-[15px] font-semibold tracking-tight text-white">
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
            'inline-flex h-9 w-9 items-center justify-center rounded-xl bg-black/75 text-white/95 transition-colors hover:bg-black/90',
            infoOpen && 'bg-accent text-white hover:bg-accent',
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
            className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-black/75 px-3 text-[12px] font-semibold tabular-nums text-white transition-colors hover:bg-[#f97316]"
          >
            <ThumbsUp size={11} />
            <span>{formatCount(folder.voteCount)}</span>
          </button>
        ) : null}
      </div>
    </div>
  )
}
