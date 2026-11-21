import { useState } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Copy, Link2, ScanSearch } from 'lucide-react'
import type { DuplicateGroupDTO, DuplicateGroupMemberDTO, DuplicateGroupState } from '@mediavault/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { formatAgo, formatBytes, formatDuration } from '../lib/format'
import { useUi } from '../store/ui'
import { useViewer } from '../store/viewer'
import { EmptyState } from '../components/EmptyState'
import { PageHeading } from '../components/PageHeading'
import { Button } from '../components/ui/Button'
import { Spinner } from '../components/ui/Spinner'

type Filter = DuplicateGroupState | 'all'

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'open', label: '검토 전' },
  { id: 'kept', label: '유지' },
  { id: 'ignored', label: '무시' },
  { id: 'all', label: '전체' },
]

const STATE_LABEL: Record<DuplicateGroupState, string> = {
  open: '검토 전',
  kept: '유지',
  ignored: '무시',
}

function joinPath(root: string, relative: string): string {
  return `${root.replace(/[\\/]+$/, '')}/${relative.replace(/^[\\/]+/, '')}`
}

function memberMeta(member: DuplicateGroupMemberDTO): string {
  if (member.kind === 'video') {
    const duration = formatDuration(member.durationMs)
    return member.width && member.height ? `${member.width}×${member.height} · ${duration}` : duration
  }
  return member.width && member.height ? `${member.width}×${member.height}` : '크기 정보 없음'
}

function reclaimable(group: DuplicateGroupDTO): number {
  const largest = Math.max(...group.members.map((member) => member.sizeBytes))
  return group.totalBytes - largest
}

export function DuplicatesPage() {
  const [filter, setFilter] = useState<Filter>('open')
  const toast = useUi((state) => state.toast)
  const openViewer = useViewer((state) => state.open)
  const queryClient = useQueryClient()

  const groups = useInfiniteQuery({
    queryKey: ['duplicates', filter],
    queryFn: ({ pageParam }) =>
      api.duplicateGroups({ state: filter, cursor: pageParam, limit: 50 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: 6_000,
  })

  const scan = useMutation({
    mutationFn: () => api.scanDuplicates(),
    onSuccess: () => {
      toast('중복 스캔을 시작했습니다. 끝나면 목록에 반영됩니다.', 'success')
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
    },
    onError: (error) => toast(error instanceof Error ? error.message : '스캔을 시작하지 못했습니다', 'error'),
  })

  const decide = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'keep' | 'ignore' }) =>
      api.decideDuplicateGroup(id, action),
    onSuccess: (_result, variables) => {
      toast(variables.action === 'keep' ? '이 그룹을 유지로 표시했습니다.' : '이 그룹을 무시했습니다.', 'success')
      queryClient.invalidateQueries({ queryKey: ['duplicates'] })
    },
    onError: (error) => toast(error instanceof Error ? error.message : '표시하지 못했습니다', 'error'),
  })

  const list = groups.data?.pages.flatMap((page) => page.groups) ?? []
  const loadedBytes = list.reduce((sum, group) => sum + group.totalBytes, 0)

  const open = async (member: DuplicateGroupMemberDTO) => {
    try {
      const asset = await api.asset(member.assetId)
      openViewer([asset], 0)
    } catch (error) {
      toast(error instanceof Error ? error.message : '파일을 열 수 없습니다', 'error')
    }
  }

  return (
    <div className="h-full overflow-y-auto overscroll-contain workspace-page">
      <PageHeading
        title="중복 검토"
        meta={
          list.length > 0
            ? `${list.length}개 그룹 · ${formatBytes(loadedBytes)}`
            : '같은 바이트의 파일만 모읍니다.'
        }
        actions={
          <Button variant="primary" onClick={() => scan.mutate()} disabled={scan.isPending}>
            <ScanSearch size={15} />
            {scan.isPending ? '시작하는 중' : '스캔 시작'}
          </Button>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setFilter(option.id)}
            className={cn(
              'min-h-10 rounded-xl px-4 text-[13px] font-medium transition-colors',
              filter === option.id
                ? 'bg-accent/15 font-medium text-accent'
                : 'text-muted hover:bg-raised/70 hover:text-ink',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <p className="mb-6 flex items-start gap-3 rounded-2xl border border-line bg-panel/50 px-4 py-3.5 text-[13px] leading-relaxed text-muted">
        <Copy size={13} className="mt-0.5 shrink-0 text-faint" />
        이 화면은 검토만 합니다. 파일을 지우거나 옮기지 않으며, 삭제는 파일 작업 엔진이 켜진 뒤
        별도 확인을 거칩니다. 해상도나 길이가 다른 편집본은 여기에 나오지 않습니다.
      </p>

      {groups.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : groups.isError ? (
        <EmptyState
          title="중복 목록을 불러오지 못했습니다"
          body="잠시 뒤 다시 시도해 주세요."
          icon={<Copy size={20} />}
        />
      ) : list.length === 0 ? (
        <EmptyState
          title={filter === 'open' ? '검토할 중복이 없습니다' : '이 상태의 그룹이 없습니다'}
          body={
            filter === 'open'
              ? '스캔을 시작하면 같은 크기의 파일을 골라 앞·중간·끝을 비교한 뒤 전체 해시로 확인합니다.'
              : '다른 상태를 골라 보세요.'
          }
          icon={<Copy size={20} />}
        />
      ) : (
        <>
          <ul className="space-y-5">
            {list.map((group) => (
              <li
                key={group.id}
                className="overflow-hidden rounded-panel border border-line bg-panel shadow-[var(--ui-elevation)]"
              >
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-5 py-4">
                  <span className="text-[15px] font-semibold text-ink">
                    {group.memberCount}개 파일 · {formatBytes(group.members[0]?.sizeBytes ?? 0)}
                  </span>
                  <span className="text-[12px] text-faint">
                    {formatBytes(reclaimable(group))} 절약 가능
                  </span>
                  {group.state !== 'open' ? (
                    <span className="rounded bg-raised px-1.5 py-0.5 text-[10.5px] text-muted">
                      {STATE_LABEL[group.state]}
                    </span>
                  ) : null}
                  <span className="ml-auto text-[11px] text-faint">
                    {formatAgo(group.createdAt)} 발견
                  </span>
                </div>

                <div className="grid gap-4 p-4 sm:grid-cols-2">
                  {group.members.map((member) => (
                    <div
                      key={member.assetId}
                      className="flex min-w-0 gap-3.5 rounded-2xl border border-line bg-canvas/60 p-3"
                    >
                      <button
                        type="button"
                        onClick={() => open(member)}
                        className="relative h-[82px] w-[122px] shrink-0 overflow-hidden rounded-xl bg-panel-2 sm:h-[92px] sm:w-[138px]"
                        title="열기"
                      >
                        <img
                          src={member.thumbnailUrl}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="h-full w-full object-contain"
                        />
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] font-semibold text-ink" title={member.filename}>
                          {member.filename}
                        </p>
                        <p
                          className="mt-0.5 truncate text-[11px] text-faint"
                          title={joinPath(member.rootPath, member.relativePath)}
                        >
                          {joinPath(member.rootPath, member.relativePath)}
                        </p>
                        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                          <span>{memberMeta(member)}</span>
                          <span>{member.libraryName}</span>
                          {member.sameInode ? (
                            <span className="inline-flex items-center gap-1 rounded bg-[#f59e0b]/15 px-1.5 py-0.5 text-[10.5px] text-[#fbbf24]">
                              <Link2 size={10} />
                              하드링크 · 삭제해도 공간이 줄지 않습니다
                            </span>
                          ) : null}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>

                {group.state === 'open' ? (
                  <div className="flex flex-wrap justify-end gap-3 border-t border-line px-5 py-4">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => decide.mutate({ id: group.id, action: 'ignore' })}
                      disabled={decide.isPending}
                    >
                      무시
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => decide.mutate({ id: group.id, action: 'keep' })}
                      disabled={decide.isPending}
                    >
                      모두 유지
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>

          {groups.hasNextPage ? (
            <div className="mt-4 flex justify-center">
              <Button
                onClick={() => groups.fetchNextPage()}
                disabled={groups.isFetchingNextPage}
              >
                {groups.isFetchingNextPage ? '불러오는 중' : '더 보기'}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
