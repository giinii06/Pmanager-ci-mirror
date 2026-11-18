import { cloneElement, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ActivityCalendar } from 'react-activity-calendar'
import 'react-activity-calendar/tooltips.css'
import {
  Activity,
  Archive,
  CalendarDays,
  DatabaseBackup,
  Film,
  Flame,
  FolderTree,
  HardDrive,
  Images,
  Loader2,
  LogOut,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sun,
  Tag,
  Trash2,
} from 'lucide-react'
import type { ArchiveJobState, LibraryDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { formatAgo, formatBytes, formatCount, formatDate } from '../lib/format'
import { useUi, type ThemeMode } from '../store/ui'
import { Dialog } from '../components/ui/Dialog'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { HostFolderPicker } from '../components/HostFolderPicker'
import { PageHeading } from '../components/PageHeading'
import { Spinner } from '../components/ui/Spinner'
import { ProcessingPanel } from '../components/ProcessingPanel'

const CALENDAR_THEME = {
  light: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'],
  dark: ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'],
}

const ORANGE_CALENDAR_THEME = {
  light: ['#f1ece6', '#fed7aa', '#fb923c', '#f97316', '#c2410c'],
  dark: ['#1c1917', '#5c280e', '#9a3412', '#ea580c', '#fb923c'],
}

const ARCHIVE_STATE_LABEL: Record<ArchiveJobState, { text: string; tone: string }> = {
  queued: { text: '대기 중', tone: 'text-muted bg-panel-2 border-line' },
  extracting: { text: '압축 해제 중', tone: 'text-accent bg-accent/10 border-accent/30' },
  converting: { text: '변환 중', tone: 'text-accent bg-accent/10 border-accent/30' },
  completed: { text: '완료', tone: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30' },
  failed_password: {
    text: '비밀번호 불일치 (원본 보존)',
    tone: 'text-amber-500 bg-amber-500/10 border-amber-500/30',
  },
  failed: { text: '실패', tone: 'text-danger bg-danger/10 border-danger/35' },
}

function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="mb-6 overflow-hidden rounded-panel border border-line bg-panel">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-[13.5px] font-semibold text-ink">{title}</h2>
          {description ? <p className="mt-0.5 text-[11.5px] text-muted">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}

function StatCard({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-panel border border-line bg-panel px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11.5px] text-muted">
        {icon}
        {label}
      </div>
      <p className="mt-1.5 text-[20px] font-semibold tabular-nums tracking-tight text-ink">
        {formatCount(value)}
      </p>
    </div>
  )
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
      <p className="text-[11px] text-muted">{label}</p>
      <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-ink">{value}</p>
    </div>
  )
}

export function SettingsPage() {
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const themeMode = useUi((state) => state.themeMode)
  const resolvedTheme = useUi((state) => state.resolvedTheme)
  const setThemeMode = useUi((state) => state.setThemeMode)

  const auth = useQuery({ queryKey: ['auth'], queryFn: api.status })
  const libraries = useQuery({
    queryKey: ['libraries'],
    queryFn: api.libraries,
    refetchInterval: (query) =>
      query.state.data?.some((library) => library.scanState !== 'idle') ? 1500 : false,
  })
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const activity = useQuery({ queryKey: ['stats', 'activity'], queryFn: api.activityStats })
  const votesActivity = useQuery({
    queryKey: ['stats', 'votes-activity'],
    queryFn: api.votesActivityStats,
  })
  const storage = useQuery({
    queryKey: ['stats', 'storage'],
    queryFn: () => api.storageStats(false),
  })
  const archives = useQuery({
    queryKey: ['archives'],
    queryFn: api.archives,
    refetchInterval: 6000,
  })
  const systemStatus = useQuery({
    queryKey: ['system', 'status'],
    queryFn: api.systemStatus,
    refetchInterval: 10_000,
  })
  const backups = useQuery({
    queryKey: ['backups'],
    queryFn: api.backups,
  })

  const [addOpen, setAddOpen] = useState(false)
  const [manualPathOpen, setManualPathOpen] = useState(false)
  const [name, setName] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<LibraryDTO | null>(null)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [selectedVoteDay, setSelectedVoteDay] = useState<string | null>(null)

  const invalidateLibraryData = () => {
    queryClient.invalidateQueries({ queryKey: ['libraries'] })
    queryClient.invalidateQueries({ queryKey: ['folders'] })
    queryClient.invalidateQueries({ queryKey: ['stats'] })
    queryClient.invalidateQueries({ queryKey: ['jobs'] })
    queryClient.invalidateQueries({ queryKey: ['assets'] })
    queryClient.invalidateQueries({ queryKey: ['archives'] })
    queryClient.invalidateQueries({ queryKey: ['system', 'status'] })
  }

  const refreshStorage = useMutation({
    mutationFn: () => api.storageStats(true),
    onSuccess: (data) => {
      queryClient.setQueryData(['stats', 'storage'], data)
      toast('저장 공간 통계를 새로고침했습니다.', 'success')
    },
    onError: () => toast('저장 공간을 계산하지 못했습니다.', 'error'),
  })

  const scan = useMutation({
    mutationFn: (id: string) => api.scanLibrary(id),
    onSuccess: () => {
      toast('스캔을 시작했습니다.', 'success')
      invalidateLibraryData()
    },
    onError: (error) =>
      toast(error instanceof Error ? error.message : '스캔을 시작하지 못했습니다.', 'error'),
  })

  const create = useMutation({
    mutationFn: () => api.createLibrary(name.trim(), rootPath.trim()),
    onSuccess: (library) => {
      toast(`${library.name} 라이브러리를 추가하고 스캔을 시작했습니다.`, 'success')
      setAddOpen(false)
      setName('')
      setRootPath('')
      setFormError(null)
      invalidateLibraryData()
    },
    onError: (error) =>
      setFormError(error instanceof Error ? error.message : '라이브러리를 추가하지 못했습니다.'),
  })

  const backupNow = useMutation({
    mutationFn: () => api.createBackup(),
    onSuccess: (res) => {
      toast(`백업을 생성했습니다 (${res.backup.filename}).`, 'success')
      queryClient.invalidateQueries({ queryKey: ['backups'] })
      queryClient.invalidateQueries({ queryKey: ['system', 'status'] })
    },
    onError: (error) =>
      toast(error instanceof Error ? error.message : '백업을 생성하지 못했습니다.', 'error'),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteLibrary(id),
    onSuccess: () => {
      toast('라이브러리를 제거했습니다. 원본 파일은 그대로입니다.')
      setPendingDelete(null)
      invalidateLibraryData()
    },
    onError: (error) =>
      toast(error instanceof Error ? error.message : '제거하지 못했습니다.', 'error'),
  })

  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      queryClient.clear()
      queryClient.setQueryData(['auth'], {
        setupRequired: false,
        authenticated: false,
        user: null,
      })
    },
  })

  const scanning = libraries.data?.some((library) => library.scanState !== 'idle') ?? false
  const dayMap = useMemo(
    () => new Map((activity.data?.days ?? []).map((day) => [day.date, day])),
    [activity.data],
  )
  const inspectedDay = selectedDay ? dayMap.get(selectedDay) ?? null : null
  const voteDayMap = useMemo(
    () => new Map((votesActivity.data?.days ?? []).map((day) => [day.date, day])),
    [votesActivity.data],
  )
  const inspectedVoteDay = selectedVoteDay ? voteDayMap.get(selectedVoteDay) ?? null : null
  const voteMetrics = useMemo(() => {
    const days = votesActivity.data?.days ?? []
    const todayVotes = days[days.length - 1]?.count ?? 0
    const last7Votes = days.slice(-7).reduce((sum, d) => sum + d.count, 0)
    const last30Votes = days.slice(-30).reduce((sum, d) => sum + d.count, 0)
    let longestStreak = 0
    let current = 0
    for (const d of days) {
      if (d.count > 0) {
        current += 1
        if (current > longestStreak) longestStreak = current
      } else {
        current = 0
      }
    }
    return { todayVotes, last7Votes, last30Votes, longestStreak }
  }, [votesActivity.data])
  const otherLibraryBytes = storage.data
    ? Math.max(0, storage.data.totalLibraryBytes - storage.data.videoBytes - storage.data.imageBytes)
    : 0
  const storageTotalFootprint = storage.data
    ? storage.data.totalLibraryBytes +
      storage.data.thumbnailBytes +
      storage.data.cacheBytes +
      storage.data.tempBytes
    : 0

  return (
    <div className="h-full overflow-y-auto overscroll-contain px-6 pb-24">
      <PageHeading
        title="설정"
        meta="테마, 라이브러리, 기여·Vote 통계, 서버 복구 및 백업 관리"
        actions={
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            <Plus size={14} />
            라이브러리 추가
          </Button>
        }
      />

      <Section title="화면 테마 (Appearance)" description="다크, 라이트 또는 시스템 OS 설정을 따릅니다.">
        <div className="flex flex-wrap items-center gap-2 p-4">
          {(
            [
              { id: 'dark', label: 'Dark', Icon: Moon },
              { id: 'light', label: 'Light', Icon: Sun },
              { id: 'system', label: 'System (OS 자동)', Icon: Monitor },
            ] as Array<{ id: ThemeMode; label: string; Icon: typeof Moon }>
          ).map(({ id, label, Icon }) => {
            const active = themeMode === id
            return (
              <button
                key={id}
                type="button"
                aria-pressed={active}
                onClick={() => setThemeMode(id)}
                className={cn(
                  'inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-[12.5px] font-medium transition-colors',
                  active
                    ? 'border-accent/60 bg-accent/15 text-accent'
                    : 'border-line bg-panel-2 text-muted hover:border-line-strong hover:text-ink',
                )}
              >
                <Icon size={14} />
                {label}
              </button>
            )
          })}
        </div>
      </Section>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={<Images size={13} />} label="사진" value={stats.data?.images ?? 0} />
        <StatCard icon={<Film size={13} />} label="동영상" value={stats.data?.videos ?? 0} />
        <StatCard icon={<FolderTree size={13} />} label="폴더" value={stats.data?.folders ?? 0} />
        <StatCard icon={<Tag size={13} />} label="태그" value={stats.data?.tags ?? 0} />
      </div>

      <Section
        title="라이브러리 기여 통계 (Contributions)"
        description="사진 폴더 추가당 1점, 사진 폴더 밖의 개별 동영상 추가당 1점으로 최초 추가 시점만 집계합니다."
      >
        {activity.isPending ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : activity.data ? (
          <div className="space-y-4 p-4">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
              <MetricPill label="누적 총 기여" value={`${formatCount(activity.data.totalCount)}건`} />
              <MetricPill
                label="사진 폴더 기여"
                value={`${formatCount(activity.data.folderContributions)}개`}
              />
              <MetricPill
                label="개별 동영상 기여"
                value={`${formatCount(activity.data.videoContributions)}개`}
              />
              <MetricPill label="활동 일수" value={`${formatCount(activity.data.activeDays)}일`} />
              <MetricPill label="연속 스트릭" value={`${formatCount(activity.data.streakDays)}일`} />
            </div>

            <div className="overflow-x-auto pb-1">
              <ActivityCalendar
                data={activity.data.days.map((d) => ({
                  date: d.date,
                  count: d.count,
                  level: d.level,
                }))}
                colorScheme={resolvedTheme}
                theme={CALENDAR_THEME}
                blockSize={12}
                blockMargin={3}
                blockRadius={2}
                fontSize={12}
                labels={{
                  months: [
                    '1월',
                    '2월',
                    '3월',
                    '4월',
                    '5월',
                    '6월',
                    '7월',
                    '8월',
                    '9월',
                    '10월',
                    '11월',
                    '12월',
                  ],
                  weekdays: ['일', '월', '화', '수', '목', '금', '토'],
                  totalCount: '최근 1년 총 {{count}}건의 기여',
                  legend: { less: '적음', more: '많음' },
                }}
                tooltips={{
                  activity: {
                    text: (act) => `${act.date} · ${act.count}건 기여`,
                  },
                }}
                renderBlock={(block, act) =>
                  cloneElement(block, {
                    onClick: () => setSelectedDay(act.date),
                    style: { cursor: 'pointer' },
                  })
                }
              />
            </div>

            {inspectedDay ? (
              <div className="rounded-lg border border-line bg-panel-2 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
                    <CalendarDays size={13} className="text-accent" />
                    {inspectedDay.date} · {formatCount(inspectedDay.count)}건
                  </p>
                  <button
                    type="button"
                    onClick={() => setSelectedDay(null)}
                    className="text-[11.5px] text-muted hover:text-ink"
                  >
                    닫기
                  </button>
                </div>
                {inspectedDay.items.length === 0 ? (
                  <p className="mt-1.5 text-[12px] text-muted">이 날짜에 기록된 추가 항목이 없습니다.</p>
                ) : (
                  <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-[12px]">
                    {inspectedDay.items.map((item) => (
                      <li key={item.id} className="flex items-center gap-2 text-muted">
                        <span className="rounded border border-line px-1.5 py-0.5 text-[10px] text-ink">
                          {item.kind === 'folder' ? '폴더' : '동영상'}
                        </span>
                        <span className="truncate text-ink">{item.name}</span>
                        <span className="ml-auto truncate text-[11px] text-faint">
                          {item.relativePath}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </Section>

      <Section
        title="Vote 활동 (주황색 잡초)"
        description="사진 폴더 및 동영상에 Vote한 일별 활동을 주황색 잔디로 추적합니다."
      >
        {votesActivity.isPending ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : votesActivity.data ? (
          <div className="space-y-4 p-4">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-6">
              <MetricPill
                label="오늘 Vote"
                value={`${formatCount(voteMetrics.todayVotes)}개`}
              />
              <MetricPill
                label="최근 7일"
                value={`${formatCount(voteMetrics.last7Votes)}개`}
              />
              <MetricPill
                label="최근 30일"
                value={`${formatCount(voteMetrics.last30Votes)}개`}
              />
              <MetricPill
                label="최장 연속 스트릭"
                value={`${formatCount(voteMetrics.longestStreak)}일`}
              />
              <MetricPill
                label="활동 일수"
                value={`${formatCount(votesActivity.data.activeDays)}일`}
              />
              <MetricPill
                label="누적 총 Vote"
                value={`${formatCount(votesActivity.data.totalVotes)}개`}
              />
            </div>

            <div className="overflow-x-auto pb-1">
              <ActivityCalendar
                data={votesActivity.data.days.map((d) => ({
                  date: d.date,
                  count: d.count,
                  level: d.level,
                }))}
                colorScheme={resolvedTheme}
                theme={ORANGE_CALENDAR_THEME}
                blockSize={12}
                blockMargin={3}
                blockRadius={2}
                fontSize={12}
                labels={{
                  months: [
                    '1월',
                    '2월',
                    '3월',
                    '4월',
                    '5월',
                    '6월',
                    '7월',
                    '8월',
                    '9월',
                    '10월',
                    '11월',
                    '12월',
                  ],
                  weekdays: ['일', '월', '화', '수', '목', '금', '토'],
                  totalCount: '최근 1년 총 {{count}}건의 Vote',
                  legend: { less: '적음', more: '많음' },
                }}
                tooltips={{
                  activity: {
                    text: (act) => `${act.date} · ${act.count}건 Vote`,
                  },
                }}
                renderBlock={(block, act) =>
                  cloneElement(block, {
                    onClick: () => setSelectedVoteDay(act.date),
                    style: { cursor: 'pointer' },
                  })
                }
              />
            </div>

            {inspectedVoteDay ? (
              <div className="rounded-lg border border-line bg-panel-2 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
                    <Flame size={13} className="text-[#f97316]" />
                    {inspectedVoteDay.date} · {formatCount(inspectedVoteDay.count)}건 Vote
                  </p>
                  <button
                    type="button"
                    onClick={() => setSelectedVoteDay(null)}
                    className="text-[11.5px] text-muted hover:text-ink"
                  >
                    닫기
                  </button>
                </div>
                {inspectedVoteDay.items.length === 0 ? (
                  <p className="mt-1.5 text-[12px] text-muted">이 날짜에 기록된 Vote가 없습니다.</p>
                ) : (
                  <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-[12px]">
                    {inspectedVoteDay.items.map((item) => (
                      <li key={item.id} className="flex items-center gap-2 text-muted">
                        <span className="rounded border border-[#f97316]/35 bg-[#f97316]/10 px-1.5 py-0.5 text-[10px] text-[#f97316]">
                          {item.targetType === 'folder' ? '폴더' : '영상'}
                        </span>
                        <span className="truncate text-ink">{item.title}</span>
                        <span className="ml-auto shrink-0 text-[11px] text-faint">
                          {formatDate(item.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </Section>

      <Section
        title="저장 공간 (Storage)"
        description="등록된 라이브러리 원본 파일, 생성된 썸네일, AI/스트리밍 캐시, 임시 작업 파일 용량입니다."
        actions={
          <Button
            size="sm"
            onClick={() => refreshStorage.mutate()}
            disabled={refreshStorage.isPending}
          >
            <RefreshCw size={12} className={refreshStorage.isPending ? 'animate-spin' : undefined} />
            새로고침
          </Button>
        }
      >
        {storage.isPending ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : storage.data ? (
          <div className="space-y-4 p-4">
            <div
              className={`grid grid-cols-2 gap-2.5 sm:grid-cols-3 ${
                otherLibraryBytes > 0 ? 'lg:grid-cols-7' : 'lg:grid-cols-6'
              }`}
            >
              <MetricPill label="전체 라이브러리" value={formatBytes(storage.data.totalLibraryBytes)} />
              <MetricPill
                label={`동영상 (${formatCount(storage.data.videoCount)}개)`}
                value={formatBytes(storage.data.videoBytes)}
              />
              <MetricPill
                label={`사진 (${formatCount(storage.data.imageCount)}개)`}
                value={formatBytes(storage.data.imageBytes)}
              />
              {otherLibraryBytes > 0 ? (
                <MetricPill label="기타/아카이브" value={formatBytes(otherLibraryBytes)} />
              ) : null}
              <MetricPill label="썸네일/프리뷰" value={formatBytes(storage.data.thumbnailBytes)} />
              <MetricPill label="캐시/인덱스" value={formatBytes(storage.data.cacheBytes)} />
              <MetricPill label="임시 파일" value={formatBytes(storage.data.tempBytes)} />
            </div>

            {storageTotalFootprint > 0 ? (
              <div className="space-y-1.5">
                <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-panel-2">
                  <div
                    className="bg-accent"
                    style={{ width: `${(storage.data.videoBytes / storageTotalFootprint) * 100}%` }}
                    title="동영상"
                  />
                  <div
                    className="bg-[#38bdf8]"
                    style={{ width: `${(storage.data.imageBytes / storageTotalFootprint) * 100}%` }}
                    title="사진"
                  />
                  {otherLibraryBytes > 0 ? (
                    <div
                      className="bg-[#fb7185]"
                      style={{ width: `${(otherLibraryBytes / storageTotalFootprint) * 100}%` }}
                      title="기타/아카이브"
                    />
                  ) : null}
                  <div
                    className="bg-[#a78bfa]"
                    style={{ width: `${(storage.data.thumbnailBytes / storageTotalFootprint) * 100}%` }}
                    title="썸네일"
                  />
                  <div
                    className="bg-[#34d399]"
                    style={{ width: `${(storage.data.cacheBytes / storageTotalFootprint) * 100}%` }}
                    title="캐시"
                  />
                  <div
                    className="bg-[#fbbf24]"
                    style={{ width: `${(storage.data.tempBytes / storageTotalFootprint) * 100}%` }}
                    title="임시 파일"
                  />
                </div>
                <p className="flex items-center justify-between text-[11px] text-faint">
                  <span>총 사용량 {formatBytes(storageTotalFootprint)}</span>
                  <span>측정 시각: {formatDate(storage.data.computedAt)}</span>
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </Section>

      <Section
        title="RAR 압축 해제 · 미디어 변환 이력"
        description="감지된 .rar 아카이브의 자동 해제, JPEG(95) 이미지 변환, H.264/AAC MP4 변환 결과입니다."
      >
        {archives.isPending ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : archives.data?.archives.length ? (
          <div className="divide-y divide-line/70">
            {archives.data.archives.slice(0, 20).map((job) => {
              const badge = ARCHIVE_STATE_LABEL[job.state]
              return (
                <div key={job.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                  <Archive size={15} className="shrink-0 text-faint" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px] font-medium text-ink">{job.archivePath}</p>
                    <p className="mt-0.5 text-[11px] text-muted">
                      해제 {formatCount(job.extractedFiles)}개 · 이미지 변환{' '}
                      {formatCount(job.convertedImages)}개 · 영상 변환{' '}
                      {formatCount(job.convertedVideos)}개
                      {job.errorMessage ? ` · ${job.errorMessage}` : ''}
                    </p>
                  </div>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${badge.tone}`}
                  >
                    {badge.text}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="px-4 py-6 text-center text-[12.5px] text-muted">
            아직 처리된 압축 파일이 없습니다.
          </p>
        )}
      </Section>

      <Section
        title="라이브러리"
        description="원본 폴더를 등록하면 파일을 감시하고 자동으로 인덱싱합니다."
        actions={
          scanning ? (
            <span className="flex items-center gap-1.5 text-[11.5px] text-accent">
              <Loader2 size={12} className="animate-spin" />
              스캔 중
            </span>
          ) : null
        }
      >
        {libraries.isPending ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : libraries.data?.length ? (
          libraries.data.map((library) => {
            const busy = library.scanState !== 'idle'
            return (
              <div
                key={library.id}
                className="flex flex-wrap items-center gap-3 border-b border-line/70 px-4 py-3 last:border-0"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-panel-2 text-muted">
                  <HardDrive size={15} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-ink">{library.name}</p>
                  <p className="mt-0.5 truncate text-[11.5px] text-muted">
                    {library.rootPath || '(미디어 루트)'} · {formatCount(library.assetCount)}개
                    {busy
                      ? ` · ${formatCount(library.scannedFiles)}개 확인 중`
                      : library.lastScanAt
                        ? ` · ${formatDate(library.lastScanAt)} 스캔`
                        : ' · 스캔 전'}
                  </p>
                </div>
                {busy ? (
                  <div className="h-1 w-24 overflow-hidden rounded-full bg-line">
                    <div className="h-full w-1/3 animate-[pulse_1.2s_ease-in-out_infinite] rounded-full bg-accent" />
                  </div>
                ) : null}
                <Button
                  size="sm"
                  onClick={() => scan.mutate(library.id)}
                  disabled={busy || scan.isPending}
                >
                  <RefreshCw size={12} />
                  스캔
                </Button>
                <Button size="sm" variant="danger" onClick={() => setPendingDelete(library)}>
                  <Trash2 size={12} />
                  제거
                </Button>
              </div>
            )
          })
        ) : (
          <div className="px-4 py-10 text-center">
            <p className="text-[13px] text-muted">등록된 라이브러리가 없습니다.</p>
            <Button className="mt-4" onClick={() => setAddOpen(true)}>
              첫 라이브러리 추가
            </Button>
          </div>
        )}
      </Section>

      <ProcessingPanel />

      <Section
        title="서버 상태 · 복구 · 데이터베이스 백업"
        description="SQLite WAL+FULL 무결성, 드라이브 마운트 상태, 크래시 복구 기록 및 검증된 DB 백업을 관리합니다."
        actions={
          <Button
            size="sm"
            variant="primary"
            disabled={backupNow.isPending}
            onClick={() => backupNow.mutate()}
          >
            <DatabaseBackup size={12} />
            {backupNow.isPending ? '백업 생성 중' : '지금 DB 백업'}
          </Button>
        }
      >
        {systemStatus.isPending ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : systemStatus.data ? (
          <div className="space-y-4 p-4">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <MetricPill label="SQLite 버전" value={systemStatus.data.sqliteVersion} />
              <MetricPill
                label="내구성 / 무결성"
                value={`${systemStatus.data.synchronousMode} · ${systemStatus.data.dbIntegrity}`}
              />
              <MetricPill
                label="실행 중인 워커"
                value={`${formatCount(systemStatus.data.activeWorkers.length)}개`}
              />
              <MetricPill
                label="최근 백업"
                value={
                  systemStatus.data.lastBackup
                    ? formatAgo(systemStatus.data.lastBackup.createdAt)
                    : '없음'
                }
              />
            </div>

            {systemStatus.data.lastRecovery ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2 text-[12px]">
                <ShieldCheck size={14} className="shrink-0 text-emerald-500" />
                <span className="font-medium text-ink">최근 자동 복구:</span>
                <span className="text-muted">
                  워커 {systemStatus.data.lastRecovery.workerId} · 복구 작업{' '}
                  {formatCount(systemStatus.data.lastRecovery.recoveredJobs)}건 · 임시 파일 정리{' '}
                  {formatCount(systemStatus.data.lastRecovery.cleanedTempFiles)}개 · 무결성{' '}
                  {systemStatus.data.lastRecovery.dbIntegrity}
                </span>
                <span className="ml-auto text-[11px] text-faint">
                  {formatDate(systemStatus.data.lastRecovery.createdAt)}
                </span>
              </div>
            ) : null}

            {systemStatus.data.libraries.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-[11px] font-medium text-muted">라이브러리 마운트 상태</p>
                <div className="divide-y divide-line/60 rounded-lg border border-line bg-panel-2/60">
                  {systemStatus.data.libraries.map((lib) => (
                    <div key={lib.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[12px]">
                      <Activity
                        size={12}
                        className={
                          lib.status === 'available' || lib.status === 'scanning'
                            ? 'text-emerald-500'
                            : 'text-danger'
                        }
                      />
                      <span className="font-medium text-ink">{lib.name}</span>
                      <span className="truncate font-mono text-[11px] text-faint">
                        {lib.rootPath || '/media'}
                      </span>
                      <span className="ml-auto text-[11px] text-muted">
                        {lib.status === 'available'
                          ? '정상'
                          : lib.status === 'scanning'
                            ? '스캔 중'
                            : lib.status === 'blocked'
                              ? '차단됨'
                              : '마운트 끊김'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {backups.data?.backups.length ? (
              <div className="space-y-1.5">
                <p className="text-[11px] font-medium text-muted">최근 데이터베이스 백업</p>
                <div className="divide-y divide-line/60 rounded-lg border border-line bg-panel-2/60">
                  {backups.data.backups.slice(0, 5).map((b) => {
                    const verified = !b.error && b.integrity === 'ok'
                    return (
                      <div key={b.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-[11.5px]">
                        <span className="font-mono text-ink">{b.filename}</span>
                        <span className="text-muted">{formatBytes(b.sizeBytes)}</span>
                        <span className={verified ? 'text-emerald-500' : 'text-danger'}>
                          {verified ? b.integrity : `실패 (${b.integrity})`}
                        </span>
                        {b.error ? (
                          <span className="max-w-[280px] truncate text-[11px] text-danger" title={b.error}>
                            {b.error}
                          </span>
                        ) : null}
                        <span className="ml-auto text-faint">{formatDate(b.createdAt)}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </Section>

      <Section title="계정" description="개인 서버이므로 계정은 하나만 사용합니다.">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/15 text-[12px] font-semibold text-accent">
            {(auth.data?.user?.username ?? '?').slice(0, 1).toUpperCase()}
          </div>
          <div className="flex-1">
            <p className="text-[13px] font-medium text-ink">
              {auth.data?.user?.username ?? '알 수 없음'}
            </p>
            <p className="text-[11.5px] text-muted">관리자</p>
          </div>
          <Button size="sm" onClick={() => logout.mutate()} disabled={logout.isPending}>
            <LogOut size={12} />
            로그아웃
          </Button>
        </div>
      </Section>

      <Dialog
        open={addOpen}
        onClose={() => {
          setAddOpen(false)
          setFormError(null)
        }}
        className="w-[min(620px,94vw)]"
        title="라이브러리 추가"
        description="Windows 드라이브(C:\\, D:\\, E:\\) 또는 MEDIA_ROOT 폴더를 탐색해 선택하세요."
        footer={
          <>
            <Button onClick={() => setAddOpen(false)}>취소</Button>
            <Button
              variant="primary"
              disabled={!name.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? '추가하는 중' : '추가하고 스캔'}
            </Button>
          </>
        }
      >
        <div className="space-y-3.5">
          <label className="block">
            <span className="mb-1.5 block text-[12px] text-muted">라이브러리 이름</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="예: 여행 사진 또는 D 드라이브"
              autoFocus
            />
          </label>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[12px] text-muted">서버 폴더 탐색기</span>
              <button
                type="button"
                onClick={() => setManualPathOpen((v) => !v)}
                className="text-[11px] text-accent hover:underline"
              >
                {manualPathOpen ? '직접 입력 숨기기' : '직접 경로 입력'}
              </button>
            </div>
            <HostFolderPicker
              selectedPath={rootPath}
              onSelect={(picked, suggestedName) => {
                setRootPath(picked)
                if (!name.trim() && suggestedName) setName(suggestedName)
              }}
            />
          </div>

          {manualPathOpen || rootPath ? (
            <label className="block">
              <span className="mb-1 block text-[11.5px] text-muted">선택된 경로</span>
              <Input
                value={rootPath}
                onChange={(event) => setRootPath(event.target.value)}
                placeholder="예: drives/d/Photos 또는 Photos"
              />
            </label>
          ) : null}

          {formError ? (
            <p className="rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-[12px] text-danger">
              {formError}
            </p>
          ) : null}
        </div>
      </Dialog>

      <Dialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        title="라이브러리를 제거할까요?"
        description="원본 파일은 삭제되지 않습니다. 인덱스와 캐시만 정리됩니다."
        footer={
          <>
            <Button onClick={() => setPendingDelete(null)}>취소</Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => pendingDelete && remove.mutate(pendingDelete.id)}
            >
              {remove.isPending ? '제거하는 중' : '제거'}
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-muted">
          <span className="text-ink">{pendingDelete?.name}</span> 폴더의 인덱스{' '}
          {formatCount(pendingDelete?.assetCount ?? 0)}개가 사라집니다.
        </p>
      </Dialog>
    </div>
  )
}
