import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Download,
  Layers,
  Loader2,
  RotateCcw,
  StopCircle,
} from 'lucide-react'
import type { BulkItemState, BulkOperationDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import {
  BULK_ITEM_STATE_LABEL,
  BULK_ITEM_TONE,
  BULK_KIND_LABEL,
  BULK_STATE_LABEL,
  BULK_STATE_TONE,
  bulkProgress,
  isBulkActive,
} from '../lib/bulk'
import { cn } from '../lib/cn'
import { formatBytes, formatCount, formatDate } from '../lib/format'
import { useUi } from '../store/ui'
import { EmptyState } from '../components/EmptyState'
import { PageHeading } from '../components/PageHeading'
import { Button } from '../components/ui/Button'
import { Progress } from '../components/ui/Progress'
import { LoadingBlock } from '../components/ui/Spinner'

function StateBadge({ operation }: { operation: BulkOperationDTO }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center rounded-full border px-2 text-[11px] font-medium',
        BULK_STATE_TONE[operation.state],
      )}
    >
      {BULK_STATE_LABEL[operation.state]}
    </span>
  )
}

function CountsLine({ operation }: { operation: BulkOperationDTO }) {
  const counts = operation.counts
  return (
    <span className="text-[11.5px] tabular-nums text-muted">
      전체 {formatCount(counts.total)} · 성공 {formatCount(counts.succeeded)}
      {counts.failed > 0 ? ` · 실패 ${formatCount(counts.failed)}` : ''}
      {counts.held > 0 ? ` · 보류 ${formatCount(counts.held)}` : ''}
      {counts.cancelled > 0 ? ` · 취소 ${formatCount(counts.cancelled)}` : ''}
    </span>
  )
}

export function BulkOperationsPage() {
  const query = useQuery({
    queryKey: ['bulk-operations'],
    queryFn: api.bulkOperations,
    refetchInterval: (state) =>
      state.state.data?.operations.some((operation) => isBulkActive(operation.state)) ? 2_500 : false,
  })

  const operations = query.data?.operations ?? []

  return (
    <div className="h-full overflow-y-auto px-6 pb-24">
      <PageHeading
        title="일괄 작업"
        meta={`최근 ${formatCount(operations.length)}개`}
        actions={
          <Link to="/videos">
            <Button size="sm">동영상에서 선택</Button>
          </Link>
        }
      />

      {query.isPending ? (
        <LoadingBlock label="일괄 작업을 불러오는 중" />
      ) : operations.length === 0 ? (
        <EmptyState
          title="일괄 작업이 없습니다"
          body="갤러리에서 선택을 켜고 여러 파일을 고른 뒤 태그·이동·삭제 같은 작업을 시작하세요."
          icon={<Layers size={20} />}
          action={
            <Link to="/videos">
              <Button>동영상으로 이동</Button>
            </Link>
          }
        />
      ) : (
        <ul className="space-y-2">
          {operations.map((operation) => (
            <li key={operation.id}>
              <Link
                to={`/bulk/${operation.id}`}
                className="block rounded-panel border border-line bg-panel p-3.5 transition-colors hover:border-line-strong"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13.5px] font-medium text-ink">
                    {BULK_KIND_LABEL[operation.kind]}
                  </span>
                  <StateBadge operation={operation} />
                  <span className="text-[11.5px] tabular-nums text-faint">
                    {formatCount(operation.snapshotCount)}개 대상
                  </span>
                  <span className="ml-auto text-[11.5px] text-faint">
                    {formatDate(operation.createdAt)}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <Progress
                    value={bulkProgress(operation.counts)}
                    label={`${BULK_KIND_LABEL[operation.kind]} 진행률`}
                    className="max-w-[320px]"
                  />
                  <CountsLine operation={operation} />
                </div>
                {operation.errorMessage ? (
                  <p className="mt-1.5 text-[11.5px] text-[#ff9c9c]">{operation.errorMessage}</p>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const ITEM_FILTERS: Array<{ value: BulkItemState | ''; label: string }> = [
  { value: '', label: '전체' },
  { value: 'failed', label: '실패' },
  { value: 'held', label: '보류' },
  { value: 'succeeded', label: '성공' },
  { value: 'cancelled', label: '취소' },
  { value: 'pending', label: '대기' },
]

export function BulkOperationPage() {
  const { id } = useParams()
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const [itemState, setItemState] = useState<BulkItemState | ''>('')
  const [itemLimit, setItemLimit] = useState(100)

  const query = useQuery({
    queryKey: ['bulk-operation', id, itemState, itemLimit],
    queryFn: () =>
      api.bulkOperation(id!, {
        ...(itemState ? { itemState } : {}),
        itemLimit,
      }),
    enabled: Boolean(id),
    refetchInterval: (state) => (state.state.data && isBulkActive(state.state.data.state) ? 2_000 : false),
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['bulk-operation', id] })
    void queryClient.invalidateQueries({ queryKey: ['bulk-operations'] })
  }

  const cancel = useMutation({
    mutationFn: () => api.cancelBulkOperation(id!),
    onSuccess: () => {
      toast('취소를 요청했습니다. 아직 시작하지 않은 파일만 취소됩니다.')
      refresh()
    },
    onError: (error) => toast(error instanceof Error ? error.message : '취소하지 못했습니다.', 'error'),
  })

  const retry = useMutation({
    mutationFn: (itemIds?: string[]) => api.retryBulkOperation(id!, itemIds),
    onSuccess: (result) => {
      toast(`${formatCount(result.reset)}개 항목을 다시 대기열에 넣었습니다.`, 'success')
      refresh()
    },
    onError: (error) => toast(error instanceof Error ? error.message : '재시도하지 못했습니다.', 'error'),
  })

  if (!id) return null
  if (query.isPending) {
    return (
      <div className="px-6">
        <LoadingBlock label="일괄 작업을 불러오는 중" />
      </div>
    )
  }
  if (query.isError || !query.data) {
    return (
      <div className="px-6">
        <EmptyState
          title="일괄 작업을 찾을 수 없습니다"
          body="삭제되었거나 주소가 잘못되었습니다."
          action={
            <Link to="/bulk">
              <Button>일괄 작업 목록</Button>
            </Link>
          }
        />
      </div>
    )
  }

  const operation = query.data
  const active = isBulkActive(operation.state)
  const terminal = !active
  const retryable = operation.counts.failed + operation.counts.held
  const exportReady =
    operation.kind === 'export' && operation.state !== 'failed' && operation.state !== 'cancelled'

  return (
    <div className="h-full overflow-y-auto px-6 pb-24">
      <div className="pt-4">
        <Link
          to="/bulk"
          className="inline-flex items-center gap-1.5 text-[12.5px] text-muted transition-colors hover:text-ink"
        >
          <ArrowLeft size={14} />
          일괄 작업 목록
        </Link>
      </div>

      <PageHeading
        title={BULK_KIND_LABEL[operation.kind]}
        meta={
          <span className="flex flex-wrap items-center gap-2">
            <StateBadge operation={operation} />
            <span>{formatCount(operation.snapshotCount)}개 대상</span>
            <span>·</span>
            <span>{formatDate(operation.createdAt)}</span>
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {exportReady ? (
              <a href={api.bulkExportUrl(operation.id)} download>
                <Button size="sm">
                  <Download size={13} />
                  CSV 내려받기
                </Button>
              </a>
            ) : null}
            {terminal && retryable > 0 ? (
              <Button
                size="sm"
                onClick={() => retry.mutate(undefined)}
                disabled={retry.isPending}
              >
                <RotateCcw size={13} />
                실패·보류 재시도
              </Button>
            ) : null}
            {active ? (
              <Button
                size="sm"
                variant="danger"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending || operation.state === 'cancelling'}
              >
                <StopCircle size={13} />
                취소
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="mb-5 rounded-panel border border-line bg-panel p-4">
        <div className="flex items-center gap-3">
          <Progress
            value={bulkProgress(operation.counts)}
            size="hero"
            label="일괄 작업 진행률"
          />
          <span className="shrink-0 text-[12px] font-medium tabular-nums text-ink">
            {bulkProgress(operation.counts)}%
          </span>
          {active ? <Loader2 size={14} className="shrink-0 animate-spin text-accent" /> : null}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] tabular-nums text-muted">
          <span>전체 {formatCount(operation.counts.total)}</span>
          <span className="text-[#7fd99a]">성공 {formatCount(operation.counts.succeeded)}</span>
          <span className="text-[#ff9c9c]">실패 {formatCount(operation.counts.failed)}</span>
          <span className="text-[#e8c77a]">보류 {formatCount(operation.counts.held)}</span>
          <span>취소 {formatCount(operation.counts.cancelled)}</span>
          <span>대기 {formatCount(operation.counts.pending)}</span>
          {operation.counts.running > 0 ? <span>진행 {formatCount(operation.counts.running)}</span> : null}
        </div>
        {operation.errorMessage ? (
          <p className="mt-2 text-[12px] text-[#ff9c9c]">{operation.errorMessage}</p>
        ) : null}
      </div>

      {operation.errorGroups.length > 0 ? (
        <div className="mb-5 rounded-panel border border-line bg-panel p-4">
          <h2 className="mb-2 text-[13px] font-semibold text-ink">오류 묶음</h2>
          <ul className="space-y-1.5">
            {operation.errorGroups.map((group) => (
              <li key={`${group.code}:${group.message}`} className="flex gap-2 text-[12px]">
                <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 font-mono text-[10.5px] text-muted">
                  {group.code}
                </span>
                <span className="min-w-0 flex-1 text-muted">{group.message}</span>
                <span className="shrink-0 tabular-nums text-faint">{formatCount(group.count)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {ITEM_FILTERS.map((filter) => (
          <button
            key={filter.value || 'all'}
            type="button"
            aria-pressed={itemState === filter.value}
            onClick={() => {
              setItemState(filter.value)
              setItemLimit(100)
            }}
            className={cn(
              'h-7 rounded-lg border px-2.5 text-[12px] font-medium transition-colors',
              itemState === filter.value
                ? 'border-accent/50 bg-accent/15 text-accent'
                : 'border-line bg-panel text-muted hover:border-line-strong hover:text-ink',
            )}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {operation.items.length === 0 ? (
        <EmptyState title="표시할 항목이 없습니다" body="다른 상태를 골라 보세요." />
      ) : (
        <div className="overflow-hidden rounded-panel border border-line">
          <table className="w-full text-left text-[12px]">
            <thead className="bg-panel-2 text-[11px] uppercase tracking-wide text-faint">
              <tr>
                <th className="px-3 py-2 font-medium">파일</th>
                <th className="w-20 px-3 py-2 font-medium">상태</th>
                <th className="w-24 px-3 py-2 text-right font-medium">크기</th>
                <th className="px-3 py-2 font-medium">결과</th>
                <th className="w-20 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {operation.items.map((item) => (
                <tr key={item.id} className="border-t border-line/70 align-top">
                  <td className="px-3 py-2">
                    <p className="truncate text-ink">{item.filename}</p>
                    <p className="truncate text-[11px] text-faint">{item.relativePath}</p>
                  </td>
                  <td className={cn('px-3 py-2 font-medium', BULK_ITEM_TONE[item.state])}>
                    {BULK_ITEM_STATE_LABEL[item.state]}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">
                    {formatBytes(item.sizeBytes)}
                  </td>
                  <td className="px-3 py-2 text-[11.5px] text-muted">
                    {item.errorMessage ?? (item.state === 'succeeded' ? '처리됨' : '')}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {terminal && (item.state === 'failed' || item.state === 'held') ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => retry.mutate([item.id])}
                        disabled={retry.isPending}
                      >
                        재시도
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {operation.items.length === itemLimit && itemLimit < 500 ? (
        <div className="mt-3 flex justify-center">
          <Button size="sm" onClick={() => setItemLimit((current) => Math.min(current + 100, 500))}>
            더 보기
          </Button>
        </div>
      ) : null}
    </div>
  )
}
