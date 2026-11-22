import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Folder as FolderIcon } from 'lucide-react'
import { POSTER_SCHEME, type TagSummaryDTO } from '@mediavault/shared'
import { useElementWidth } from '../lib/hooks'
import { formatCount } from '../lib/format'
import { buildVideoTagRows } from '../lib/videoTagLayout'
import { Thumb } from './Thumb'

export function VideoTagGrid({ tags }: { tags: TagSummaryDTO[] }) {
  const [widthRef, width] = useElementWidth<HTMLDivElement>()
  const rows = useMemo(() => buildVideoTagRows(tags, width), [tags, width])

  return (
    <div ref={widthRef} className="min-w-0">
      {rows.map((row) => (
        <div key={row.key} className="mb-2 flex items-start gap-2">
          {row.items.map(({ item: tag, width: coverWidth, height: coverHeight }) => (
            <Link
              key={tag.id}
              to={`/videos/tags/${tag.id}`}
              style={{ width: coverWidth }}
              aria-label={`${tag.name}, ${formatCount(tag.assetCount)}개 동영상`}
              className="group block shrink-0 overflow-hidden rounded-panel"
            >
              <div className="relative w-full overflow-hidden bg-panel-2" style={{ height: coverHeight }}>
                {tag.coverAssetId ? (
                  <Thumb
                    src={`/api/assets/${tag.coverAssetId}/thumbnail?size=640&pv=${tag.coverPosterVersion ?? 1}&p=${POSTER_SCHEME}`}
                    alt={tag.name}
                    className="h-full w-full"
                    imageClassName="transition-transform duration-500 ease-out group-hover:scale-[1.03]"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-faint">
                    <FolderIcon size={26} strokeWidth={1.4} />
                  </div>
                )}
                <div className="pointer-events-none absolute inset-x-2 bottom-2 rounded-lg bg-black/70 px-2.5 py-1.5 opacity-0 backdrop-blur-sm transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
                  <p className="truncate text-[12.5px] font-medium text-white/95">{tag.name}</p>
                  <p className="text-[11px] text-white/70">{formatCount(tag.assetCount)}개 동영상</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      ))}
    </div>
  )
}
