import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { AssetDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { invalidateVoteCaches, patchAssetInCaches } from '../lib/cachePatch'
import { buildGalleryEntries } from '../lib/justified'
import { useElementWidth } from '../lib/hooks'
import { useUi } from '../store/ui'
import { AssetTile } from './AssetTile'
import { LoadingBlock } from './ui/Spinner'

interface JustifiedGridProps {
  items: AssetDTO[]
  scrollRef: RefObject<HTMLDivElement | null>
  header?: ReactNode
  loading: boolean
  hasNextPage: boolean
  isFetchingNextPage: boolean
  fetchNextPage: () => void
  onOpen: (index: number) => void
  empty: ReactNode
  groupByMonth?: boolean
}

const GAP = 3

export function JustifiedGrid({
  items,
  scrollRef,
  header,
  loading,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  onOpen,
  empty,
  groupByMonth,
}: JustifiedGridProps) {
  const [widthRef, width] = useElementWidth<HTMLDivElement>()
  const headerRef = useRef<HTMLDivElement>(null)
  const [headerHeight, setHeaderHeight] = useState(0)
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)

  const vote = useMutation({
    mutationFn: (id: string) => api.voteAsset(id),
    onSuccess: (updated) => {
      patchAssetInCaches(queryClient, updated)
      invalidateVoteCaches(queryClient)
    },
    onError: () => toast('투표를 저장하지 못했습니다.', 'error'),
  })

  useLayoutEffect(() => {
    const element = headerRef.current
    if (!element) return
    const measure = () => setHeaderHeight(element.getBoundingClientRect().height)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [header])

  const entries = useMemo(
    () => buildGalleryEntries(items, width, { gap: GAP, groupByMonth }),
    [items, width, groupByMonth],
  )
  const scrollMargin = headerHeight

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => entries[index]?.height ?? 0,
    overscan: 8,
    scrollMargin,
  })

  const virtualItems = virtualizer.getVirtualItems()
  const lastIndex = virtualItems[virtualItems.length - 1]?.index ?? -1

  useEffect(() => {
    if (lastIndex < 0) return
    if (lastIndex >= entries.length - 4 && hasNextPage && !isFetchingNextPage) fetchNextPage()
  }, [lastIndex, entries.length, hasNextPage, isFetchingNextPage, fetchNextPage])

  return (
    <div className="px-6 pb-24">
      <div ref={headerRef}>{header}</div>

      {loading && items.length === 0 ? <LoadingBlock label="불러오는 중" /> : null}

      {!loading && items.length === 0 ? empty : null}

      {items.length > 0 ? (
        <div ref={widthRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((virtualItem) => {
            const entry = entries[virtualItem.index]
            if (!entry) return null
            return (
              <div
                key={entry.key}
                data-index={virtualItem.index}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualItem.start - scrollMargin}px)` }}
              >
                {entry.kind === 'header' ? (
                  <div className="flex h-[52px] items-end pb-2">
                    <h2 className="text-[17px] font-semibold tracking-tight text-ink">{entry.label}</h2>
                  </div>
                ) : (
                  <div className="flex" style={{ gap: GAP }}>
                    {entry.items.map((placed) => (
                      <AssetTile
                        key={placed.item.id}
                        asset={placed.item}
                        width={placed.width}
                        height={placed.height}
                        priority={placed.index < 16}
                        onOpen={() => onOpen(placed.index)}
                        onVote={
                          placed.item.kind === 'video'
                            ? () => vote.mutate(placed.item.id)
                            : undefined
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : null}

      {isFetchingNextPage ? <LoadingBlock label="더 불러오는 중" /> : null}
    </div>
  )
}
