import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { CheckSquare } from 'lucide-react'
import type { AssetDTO, AssetQuery, Page } from '@mediavault/shared'
import { api } from '../lib/api'
import { formatCount } from '../lib/format'
import { useSelection } from '../store/selection'
import { useViewer } from '../store/viewer'
import { EmptyState } from './EmptyState'
import { JustifiedGrid } from './JustifiedGrid'
import { PageHeading } from './PageHeading'
import { SelectionBar } from './SelectionBar'
import { Button } from './ui/Button'

interface AssetGalleryProps {
  title: string
  filters: AssetQuery
  meta?: ReactNode
  actions?: ReactNode
  breadcrumb?: ReactNode
  subheader?: ReactNode
  emptyTitle: string
  emptyBody: string
  emptyAction?: ReactNode
  emptyIcon?: ReactNode
  hideEmpty?: boolean
  groupByMonth?: boolean
}

export function AssetGallery({
  title,
  filters,
  meta,
  actions,
  breadcrumb,
  subheader,
  emptyTitle,
  emptyBody,
  emptyAction,
  emptyIcon,
  hideEmpty,
  groupByMonth,
}: AssetGalleryProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  const query = useInfiniteQuery({
    queryKey: ['assets', filters],
    queryFn: ({ pageParam }) => api.assets({ ...filters, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page<AssetDTO>) => last.nextCursor,
  })

  const items = useMemo(() => {
    const seen = new Set<string>()
    const flat: AssetDTO[] = []
    for (const page of query.data?.pages ?? []) {
      for (const item of page.items) {
        if (seen.has(item.id)) continue
        seen.add(item.id)
        flat.push(item)
      }
    }
    return flat
  }, [query.data])

  const total = query.data?.pages[0]?.total ?? 0
  const selectionActive = useSelection((state) => state.active)
  const selectionIds = useSelection((state) => state.ids)
  const toggleSelection = useSelection((state) => state.toggle)
  const startSelection = useSelection((state) => state.start)
  const selectionSet = useMemo(() => new Set(selectionIds), [selectionIds])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
    // A different filter or page is a different result set, so a selection made
    // against the old one must not carry over.
    if (useSelection.getState().active) useSelection.getState().stop()
  }, [
    filters.libraryId,
    filters.folderId,
    filters.kind,
    filters.tagId,
    filters.albumId,
    filters.sort,
    filters.seed,
    filters.q,
  ])

  const heading = (
    <>
      {breadcrumb}
      <PageHeading
        title={title}
        meta={meta ?? `${formatCount(total)}개`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {actions}
            {!selectionActive ? (
              <Button size="sm" onClick={startSelection}>
                <CheckSquare size={13} />
                선택
              </Button>
            ) : null}
          </div>
        }
      />
    </>
  )

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto">
      {query.isError ? (
        <div className="px-6 pb-24">
          {heading}
          <EmptyState
            title="불러오지 못했습니다"
            body={query.error instanceof Error ? query.error.message : '잠시 후 다시 시도해 주세요.'}
            action={<Button onClick={() => query.refetch()}>다시 시도</Button>}
          />
        </div>
      ) : (
        <JustifiedGrid
          items={items}
          scrollRef={scrollRef}
          header={
            <>
              {heading}
              {subheader}
              <SelectionBar filters={filters} loadedIds={items.map((item) => item.id)} />
            </>
          }
          loading={query.isPending}
          hasNextPage={query.hasNextPage}
          isFetchingNextPage={query.isFetchingNextPage}
          fetchNextPage={() => query.fetchNextPage()}
          onOpen={(index) => useViewer.getState().open(items, index, { filter: filters })}
          groupByMonth={groupByMonth}
          selection={
            selectionActive ? { ids: selectionSet, onToggle: toggleSelection } : undefined
          }
          empty={
            hideEmpty ? null : (
              <EmptyState
                title={emptyTitle}
                body={emptyBody}
                icon={emptyIcon}
                action={emptyAction}
              />
            )
          }
        />
      )}
    </div>
  )
}
