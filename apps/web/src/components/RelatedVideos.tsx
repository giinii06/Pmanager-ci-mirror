import type { AssetDTO } from '@mediavault/shared'
import { formatDay, formatDuration } from '../lib/format'

export function RelatedVideos({
  items,
  loading,
  onSelect,
}: {
  items: AssetDTO[]
  loading: boolean
  onSelect: (asset: AssetDTO) => void
}) {
  return (
    <aside className="min-w-0">
      <h2 className="text-[15px] font-semibold text-ink">다음 영상</h2>
      {loading ? null : items.length === 0 ? (
        <p className="mt-3 text-[13px] text-faint">관련 영상이 없습니다.</p>
      ) : (
        <div className="mt-3 space-y-1.5">
          {items.map((item) => {
            const meta = [formatDuration(item.durationMs), formatDay(item.takenAt)]
              .filter(Boolean)
              .join(' · ')
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item)}
                className="flex w-full flex-col items-start gap-2 rounded-xl p-2 text-left transition-colors hover:bg-panel-2"
              >
                <span className="block aspect-[84/47] w-[336px] max-w-full overflow-hidden rounded-lg bg-panel-2">
                  <img
                    src={item.thumbnails.medium}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                </span>
                <span className="block w-full min-w-0 pb-1">
                  <span className="line-clamp-2 block text-[13.5px] font-medium leading-snug text-ink">
                    {item.filename}
                  </span>
                  <span className="mt-1 block text-[12px] text-faint">{meta}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </aside>
  )
}
