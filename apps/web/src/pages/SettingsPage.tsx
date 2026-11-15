import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Film,
  FolderTree,
  HardDrive,
  Heart,
  Images,
  Loader2,
  LogOut,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import type { JobDTO, LibraryDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { formatCount, formatDate } from '../lib/format'
import { cn } from '../lib/cn'
import { useUi } from '../store/ui'
import { Dialog } from '../components/ui/Dialog'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { PageHeading } from '../components/PageHeading'
import { Spinner } from '../components/ui/Spinner'

const JOB_LABELS: Record<string, string> = {
  scan_library: '폴더 스캔',
  thumbnail: '썸네일',
  preview: '프리뷰',
  hls: 'HLS 변환',
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

function JobRow({ job }: { job: JobDTO }) {
  return (
    <div className="flex items-center gap-3 border-b border-line/60 px-4 py-2 last:border-0">
      <span
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          job.state === 'running'
            ? 'bg-accent'
            : job.state === 'failed'
              ? 'bg-danger'
              : 'bg-faint',
        )}
      />
      <span className="w-24 shrink-0 text-[12px] text-ink">
        {JOB_LABELS[job.kind] ?? job.kind}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted">
        {job.lastError ?? `${job.assetId ?? job.libraryId ?? ''} · P${job.priority}`}
      </span>
      <span className="shrink-0 text-[10.5px] tabular-nums text-faint">
        {job.attempts}/{job.maxAttempts}
      </span>
    </div>
  )
}

export function SettingsPage() {
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)

  const auth = useQuery({ queryKey: ['auth'], queryFn: api.status })
  const libraries = useQuery({
    queryKey: ['libraries'],
    queryFn: api.libraries,
    refetchInterval: (query) =>
      query.state.data?.some((library) => library.scanState !== 'idle') ? 1500 : false,
  })
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: api.jobs, refetchInterval: 4000 })
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })

  const [addOpen, setAddOpen] = useState(false)
  const [name, setName] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<LibraryDTO | null>(null)

  const invalidateLibraryData = () => {
    queryClient.invalidateQueries({ queryKey: ['libraries'] })
    queryClient.invalidateQueries({ queryKey: ['folders'] })
    queryClient.invalidateQueries({ queryKey: ['stats'] })
    queryClient.invalidateQueries({ queryKey: ['jobs'] })
    queryClient.invalidateQueries({ queryKey: ['assets'] })
  }

  const scan = useMutation({
    mutationFn: (id: string) => api.scanLibrary(id),
    onSuccess: () => {
      toast('스캔을 시작했습니다.', 'success')
      invalidateLibraryData()
    },
    onError: (error) => toast(error instanceof Error ? error.message : '스캔을 시작하지 못했습니다.', 'error'),
  })

  const create = useMutation({
    mutationFn: async () => {
      const library = await api.createLibrary(name.trim(), rootPath.trim())
      api.scanLibrary(library.id).catch(() => undefined)
      return library
    },
    onSuccess: (library) => {
      toast(`${library.name} 라이브러리를 추가했습니다.`, 'success')
      setAddOpen(false)
      setName('')
      setRootPath('')
      setFormError(null)
      invalidateLibraryData()
    },
    onError: (error) =>
      setFormError(error instanceof Error ? error.message : '라이브러리를 추가하지 못했습니다.'),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteLibrary(id),
    onSuccess: () => {
      toast('라이브러리를 제거했습니다. 원본 파일은 그대로입니다.')
      setPendingDelete(null)
      invalidateLibraryData()
    },
    onError: (error) => toast(error instanceof Error ? error.message : '제거하지 못했습니다.', 'error'),
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

  const counts = jobs.data?.counts
  const scanning = libraries.data?.some((library) => library.scanState !== 'idle') ?? false

  return (
    <div className="h-full overflow-y-auto px-6 pb-24">
      <PageHeading
        title="설정"
        meta="원본은 읽기 전용으로 접근하고, 인덱스와 캐시만 이 서버에 저장합니다."
        actions={
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            <Plus size={14} />
            라이브러리 추가
          </Button>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={<Images size={13} />} label="사진" value={stats.data?.images ?? 0} />
        <StatCard icon={<Film size={13} />} label="동영상" value={stats.data?.videos ?? 0} />
        <StatCard icon={<Heart size={13} />} label="즐겨찾기" value={stats.data?.favorites ?? 0} />
        <StatCard icon={<FolderTree size={13} />} label="폴더" value={stats.data?.folders ?? 0} />
      </div>

      <Section
        title="라이브러리"
        description="원본 폴더를 등록하면 파일은 옮기지 않고 인덱스만 만듭니다."
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

      <Section
        title="작업 큐"
        description="우선순위가 낮은 작업은 뒤로 밀리고, 화면에 보이는 사진이 먼저 처리됩니다."
      >
        <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
          {(['queued', 'running', 'done', 'failed'] as const).map((state) => (
            <div key={state} className="bg-panel px-4 py-3">
              <p className="text-[10.5px] uppercase tracking-[0.08em] text-faint">
                {state === 'queued'
                  ? '대기'
                  : state === 'running'
                    ? '처리 중'
                    : state === 'done'
                      ? '완료'
                      : '실패'}
              </p>
              <p className="mt-1 text-[18px] font-semibold tabular-nums text-ink">
                {formatCount(counts?.[state] ?? 0)}
              </p>
            </div>
          ))}
        </div>

        {jobs.data?.active.length ? (
          <div className="border-t border-line">
            <p className="px-4 pb-1 pt-3 text-[10.5px] uppercase tracking-[0.08em] text-faint">
              진행 중
            </p>
            {jobs.data.active.slice(0, 8).map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </div>
        ) : null}

        {jobs.data?.recentFailures.length ? (
          <div className="border-t border-line">
            <p className="flex items-center gap-1.5 px-4 pb-1 pt-3 text-[10.5px] uppercase tracking-[0.08em] text-faint">
              <AlertTriangle size={11} className="text-danger" />
              최근 실패
            </p>
            {jobs.data.recentFailures.slice(0, 6).map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </div>
        ) : null}
      </Section>

      <Section title="계정" description="개인 서버이므로 계정은 하나만 사용합니다.">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/15 text-[12px] font-semibold text-accent">
            {(auth.data?.user?.username ?? '?').slice(0, 1).toUpperCase()}
          </div>
          <div className="flex-1">
            <p className="text-[13px] font-medium text-ink">{auth.data?.user?.username ?? '알 수 없음'}</p>
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
        title="라이브러리 추가"
        description="서버의 MEDIA_ROOT 아래에 있는 폴더만 등록할 수 있습니다."
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
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-[12px] text-muted">이름</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="예: 가족 사진"
              autoFocus
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12px] text-muted">경로</span>
            <Input
              value={rootPath}
              onChange={(event) => setRootPath(event.target.value)}
              placeholder="예: Photos 또는 /mnt/d/Media/Photos"
            />
            <span className="mt-1.5 block text-[11.5px] leading-relaxed text-faint">
              MEDIA_ROOT 기준 상대 경로를 권장합니다. 절대 경로도 MEDIA_ROOT 안이면 사용할 수
              있습니다.
            </span>
          </label>
          {formError ? (
            <p className="rounded-lg border border-[#4a2a2e] bg-[#241518] px-3 py-2 text-[12px] text-[#ffc9c9]">
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
