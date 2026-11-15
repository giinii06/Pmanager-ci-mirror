import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, ScanSearch, Users } from 'lucide-react'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { useUi } from '../store/ui'
import { EmptyState } from '../components/EmptyState'
import { PageHeading } from '../components/PageHeading'
import { PersonCard } from '../components/PersonCard'
import { PersonReview } from '../components/PersonReview'
import { Button } from '../components/ui/Button'
import { Spinner } from '../components/ui/Spinner'

type Tab = 'approved' | 'candidate'

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'approved', label: '인물' },
  { key: 'candidate', label: '검토 대기' },
]

export function PeoplePage() {
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const [tab, setTab] = useState<Tab>('approved')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const list = useQuery({
    queryKey: ['people', tab],
    queryFn: () => api.people(tab),
  })
  const everyone = useQuery({
    queryKey: ['people', 'all'],
    queryFn: () => api.people('all'),
  })

  const rescan = useMutation({
    mutationFn: api.rescanPeople,
    onSuccess: async (result) => {
      toast(`검토 대기를 다시 묶었습니다 (${result.counts.candidate}개)`, 'success')
      setSelectedId(null)
      await queryClient.invalidateQueries({ queryKey: ['people'] })
    },
    onError: (error) =>
      toast(error instanceof Error ? error.message : '다시 묶지 못했습니다', 'error'),
  })

  const runIndex = useMutation({
    mutationFn: api.runIndex,
    onSuccess: (result) => {
      toast(
        result.scenes + result.faces > 0
          ? `색인 작업을 ${result.scenes + result.faces}개 넣었습니다`
          : '새로 색인할 영상이 없습니다',
        'success',
      )
    },
    onError: (error) =>
      toast(error instanceof Error ? error.message : '색인을 시작하지 못했습니다', 'error'),
  })

  const counts = list.data?.counts
  const people = list.data?.people ?? []

  return (
    <div className="px-6 pb-24">
      <PageHeading
        title="인물"
        meta={
          counts
            ? `승인 ${counts.approved} · 검토 대기 ${counts.candidate} · 제외 ${counts.excluded}`
            : '얼굴로 인물을 찾고 묶습니다.'
        }
        actions={
          <>
            <Button
              size="sm"
              onClick={() => runIndex.mutate()}
              disabled={runIndex.isPending}
              title="장면과 얼굴 색인 작업을 지금 넣습니다"
            >
              <ScanSearch size={14} /> 색인 실행
            </Button>
            <Button
              size="sm"
              onClick={() => rescan.mutate()}
              disabled={rescan.isPending}
              title="검토 대기를 버리고 남은 얼굴을 다시 묶습니다"
            >
              <RefreshCw size={14} className={rescan.isPending ? 'animate-spin' : undefined} />
              다시 묶기
            </Button>
          </>
        }
      >
        <div className="mt-4 flex gap-1 border-b border-line">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={cn(
                '-mb-px border-b-2 px-3 pb-2 text-[13px] transition-colors',
                tab === item.key
                  ? 'border-accent text-ink'
                  : 'border-transparent text-muted hover:text-ink',
              )}
            >
              {item.label}
              {counts ? (
                <span className="ml-1.5 text-[11px] tabular-nums text-faint">
                  {counts[item.key]}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </PageHeading>

      {list.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : people.length === 0 ? (
        <EmptyState
          title={tab === 'approved' ? '아직 승인한 인물이 없습니다' : '검토할 인물이 없습니다'}
          body={
            tab === 'approved'
              ? '검토 대기에서 얼굴을 확인하고 승인하면 여기에 모입니다. 승인한 인물만 영상에서 이름으로 이어집니다.'
              : '영상을 색인하면 얼굴이 자동으로 묶입니다. 색인 실행을 눌러 지금 시작할 수 있습니다.'
          }
          icon={<Users size={20} />}
          action={
            tab === 'approved' && (counts?.candidate ?? 0) > 0 ? (
              <Button onClick={() => setTab('candidate')}>검토 대기 보기</Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {people.map((person) => (
            <PersonCard
              key={person.id}
              person={person}
              selected={person.id === selectedId}
              onOpen={() => setSelectedId(person.id)}
            />
          ))}
        </div>
      )}

      {selectedId ? (
        <PersonReview
          personId={selectedId}
          people={everyone.data?.people ?? people}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </div>
  )
}
