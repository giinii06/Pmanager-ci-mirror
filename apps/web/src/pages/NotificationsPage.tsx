import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellOff, Check, X } from 'lucide-react'
import type { NotificationDTO, NotificationState } from '@mediavault/shared'
import { api, ApiError } from '../lib/api'
import { cn } from '../lib/cn'
import { formatAgo, formatCount } from '../lib/format'
import { useUi } from '../store/ui'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/EmptyState'
import { PageHeading } from '../components/PageHeading'
import { Section } from '../components/ui/Section'
import { Spinner } from '../components/ui/Spinner'

const STATE_LABEL: Record<NotificationState, string> = {
  open: '진행 중',
  resolved: '복구됨',
  dismissed: '닫음',
}

const SEVERITY_TONE: Record<NotificationDTO['severity'], string> = {
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-500',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-500',
  critical: 'border-rose-500/30 bg-rose-500/10 text-rose-500',
}

const SEVERITY_LABEL: Record<NotificationDTO['severity'], string> = {
  info: '안내',
  warning: '경고',
  critical: '심각',
}

type Filter = 'open' | 'resolved' | 'dismissed' | 'all'

export function NotificationsPage() {
  const [filter, setFilter] = useState<Filter>('open')
  const toast = useUi((state) => state.toast)
  const queryClient = useQueryClient()

  const list = useQuery({
    queryKey: ['notifications', filter],
    queryFn: () => api.notifications(filter === 'all' ? { limit: 100 } : { state: filter, limit: 100 }),
    refetchInterval: 30_000,
    retry: false,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['notifications'] })
  }

  const read = useMutation({
    mutationFn: (id: string) => api.readNotification(id),
    onSuccess: invalidate,
    onError: (error) =>
      toast(error instanceof Error ? error.message : '읽음 처리하지 못했습니다.', 'error'),
  })

  const dismiss = useMutation({
    mutationFn: (id: string) => api.dismissNotification(id),
    onSuccess: invalidate,
    onError: (error) =>
      toast(error instanceof Error ? error.message : '알림을 닫지 못했습니다.', 'error'),
  })

  const disabled = list.error instanceof ApiError && list.error.status === 404
  const notifications = list.data?.notifications ?? []
  const unread = notifications.filter((item) => item.state === 'open' && item.readAt === null).length

  return (
    <div className="h-full overflow-y-auto overscroll-contain px-6 pb-24">
      <PageHeading
        title="알림"
        meta="드라이브, 백업, 디스크, 작업 실패를 한 곳에서 확인합니다."
        actions={
          <Button
            size="sm"
            onClick={() => list.refetch()}
            disabled={list.isFetching}
          >
            새로고침
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {(['open', 'resolved', 'dismissed', 'all'] as Filter[]).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors',
              filter === value
                ? 'border-accent/60 bg-accent/15 text-accent'
                : 'border-line bg-panel-2 text-muted hover:border-line-strong hover:text-ink',
            )}
          >
            {value === 'all' ? '전체' : STATE_LABEL[value]}
          </button>
        ))}
        {unread > 0 ? (
          <span className="ml-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
            읽지 않음 {formatCount(unread)}
          </span>
        ) : null}
      </div>

      <Section
        title="알림 기록"
        description="같은 조건은 한 줄로 합쳐지고, 발생 횟수와 마지막 확인 시각이 갱신됩니다."
      >
        {disabled ? (
          <EmptyState
            icon={<BellOff size={22} />}
            title="알림이 꺼져 있습니다"
            body="서버에서 NOTIFICATIONS_ENABLED=1 로 켜면 이 화면과 Discord 전송이 활성화됩니다."
          />
        ) : list.isPending ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : list.isError ? (
          <p className="px-4 py-8 text-center text-[12.5px] text-danger">
            {list.error instanceof Error ? list.error.message : '알림을 불러오지 못했습니다.'}
          </p>
        ) : notifications.length === 0 ? (
          <p className="px-4 py-8 text-center text-[12.5px] text-muted">
            표시할 알림이 없습니다.
          </p>
        ) : (
          <div className="divide-y divide-line/70">
            {notifications.map((notification) => (
              <article key={notification.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <span
                  className={cn(
                    'mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] font-medium',
                    SEVERITY_TONE[notification.severity],
                  )}
                >
                  {SEVERITY_LABEL[notification.severity]}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-ink">
                    {notification.title}
                    {notification.state === 'open' && notification.readAt === null ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-label="읽지 않음" />
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{notification.body}</p>
                  <p className="mt-1 text-[11px] text-faint">
                    {STATE_LABEL[notification.state]} · 발생 {formatCount(notification.occurrences)}회
                    · 마지막 확인 {formatAgo(notification.lastSeenAt)}
                    {notification.resolvedAt ? ` · 복구 ${formatAgo(notification.resolvedAt)}` : ''}
                  </p>
                </div>
                {notification.state === 'open' ? (
                  <div className="flex shrink-0 items-center gap-1">
                    {notification.readAt === null ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => read.mutate(notification.id)}
                        disabled={read.isPending}
                      >
                        <Check size={12} />
                        읽음
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => dismiss.mutate(notification.id)}
                      disabled={dismiss.isPending}
                    >
                      <X size={12} />
                      닫기
                    </Button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}
