import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, GitMerge, Pencil, Scissors, ShieldOff, X } from 'lucide-react'
import type { PersonDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { formatDuration } from '../lib/format'
import { useUi } from '../store/ui'
import { useViewer } from '../store/viewer'
import { Button } from './ui/Button'
import { Spinner } from './ui/Spinner'

const STATE_LABEL: Record<PersonDTO['state'], string> = {
  approved: '승인됨',
  candidate: '검토 대기',
  excluded: '제외됨',
}

export function PersonReview({
  personId,
  people,
  onClose,
}: {
  personId: string
  people: PersonDTO[]
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const openViewer = useViewer((state) => state.open)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [mergeSource, setMergeSource] = useState('')

  const detail = useQuery({ queryKey: ['person', personId], queryFn: () => api.person(personId) })
  const assets = useQuery({
    queryKey: ['person-assets', personId],
    queryFn: () => api.personAssets(personId),
  })

  useEffect(() => {
    setSelected([])
    setMergeSource('')
    setRenaming(false)
  }, [personId])

  useEffect(() => {
    if (detail.data && !renaming) setName(detail.data.person.name)
  }, [detail.data, renaming])

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['person', personId] }),
      queryClient.invalidateQueries({ queryKey: ['person-assets', personId] }),
      queryClient.invalidateQueries({ queryKey: ['people'] }),
    ])
  }

  const onError = (error: unknown) =>
    toast(error instanceof Error ? error.message : '요청이 실패했습니다', 'error')

  const approve = useMutation({
    mutationFn: () => api.approvePerson(personId),
    onSuccess: async () => {
      toast('인물을 승인했습니다', 'success')
      await refresh()
    },
    onError,
  })
  const exclude = useMutation({
    mutationFn: () => api.excludePerson(personId),
    onSuccess: async () => {
      toast('인물을 제외했습니다', 'success')
      await refresh()
      onClose()
    },
    onError,
  })
  const rename = useMutation({
    mutationFn: (next: string) => api.renamePerson(personId, next),
    onSuccess: async () => {
      setRenaming(false)
      await refresh()
    },
    onError,
  })
  const split = useMutation({
    mutationFn: (ids: string[]) => api.splitPerson(personId, ids),
    onSuccess: async () => {
      toast('선택한 얼굴을 새 인물로 분리했습니다', 'success')
      setSelected([])
      await refresh()
    },
    onError,
  })
  const merge = useMutation({
    mutationFn: (sourceId: string) => api.mergePeople(personId, sourceId),
    onSuccess: async () => {
      toast('인물을 합쳤습니다', 'success')
      setMergeSource('')
      await refresh()
    },
    onError,
  })

  const person = detail.data?.person
  const faces = detail.data?.faces ?? []
  const others = people.filter((candidate) => candidate.id !== personId)
  const canSplit = selected.length > 0 && selected.length < faces.length

  const toggleFace = (detectionId: string) => {
    setSelected((current) =>
      current.includes(detectionId)
        ? current.filter((id) => id !== detectionId)
        : [...current, detectionId],
    )
  }

  const openAsset = async (assetId: string, frameMs: number | null) => {
    try {
      const asset = await api.asset(assetId)
      openViewer([asset], 0, frameMs)
    } catch (error) {
      onError(error)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex justify-end bg-black/50 backdrop-blur-[1px]"
      onClick={onClose}
      role="presentation"
    >
      <aside
        className="flex h-full w-full max-w-[460px] flex-col border-l border-line bg-panel shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        aria-label="인물 검토"
      >
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            {renaming ? (
              <form
                className="flex items-center gap-1.5"
                onSubmit={(event) => {
                  event.preventDefault()
                  const next = name.trim()
                  if (next) rename.mutate(next)
                }}
              >
                <input
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={60}
                  className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-raised px-2 text-[13px] text-ink outline-none focus:border-accent/60"
                />
                <Button size="sm" type="submit" disabled={rename.isPending || !name.trim()}>
                  저장
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>
                  취소
                </Button>
              </form>
            ) : (
              <div className="flex items-center gap-2">
                <h2 className="truncate text-[15px] font-semibold text-ink">
                  {person?.name ?? '인물'}
                </h2>
                {person ? (
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium',
                      person.state === 'approved'
                        ? 'bg-[#4ade80]/15 text-[#86efac]'
                        : person.state === 'excluded'
                          ? 'bg-[#f87171]/15 text-[#fca5a5]'
                          : 'bg-white/[0.07] text-muted',
                    )}
                  >
                    {STATE_LABEL[person.state]}
                  </span>
                ) : null}
              </div>
            )}
            <p className="mt-0.5 text-[11.5px] text-faint">
              얼굴 {person?.faceCount ?? 0}개 · 영상 {person?.assetCount ?? 0}개
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-raised hover:text-ink"
          >
            <X size={16} />
          </button>
        </header>

        {detail.isPending ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner />
          </div>
        ) : !person ? (
          <p className="p-4 text-[13px] text-muted">인물을 찾을 수 없습니다.</p>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="primary" onClick={() => approve.mutate()} disabled={approve.isPending || person.state === 'approved'}>
                <Check size={13} /> 승인
              </Button>
              <Button size="sm" variant="danger" onClick={() => exclude.mutate()} disabled={exclude.isPending || person.state === 'excluded'}>
                <ShieldOff size={13} /> 제외
              </Button>
              <Button size="sm" onClick={() => setRenaming(true)}>
                <Pencil size={13} /> 이름
              </Button>
            </div>

            <section className="mt-5">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-faint">
                  얼굴
                </h3>
                <span className="text-[11px] text-faint">눌러서 분리할 얼굴 선택</span>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {faces.map((face) => {
                  const picked = selected.includes(face.detectionId)
                  return (
                    <button
                      key={face.detectionId}
                      type="button"
                      onClick={() => toggleFace(face.detectionId)}
                      title={`${face.filename} · ${formatDuration(face.frameMs)}`}
                      className={cn(
                        'relative aspect-square overflow-hidden rounded-lg border transition-colors',
                        picked ? 'border-accent' : 'border-transparent hover:border-line-strong',
                      )}
                    >
                      <img src={face.url} alt="" loading="lazy" className="h-full w-full object-cover" />
                      {picked ? (
                        <span className="absolute inset-0 flex items-center justify-center bg-accent/25 text-white">
                          <Check size={16} />
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
              <Button
                size="sm"
                className="mt-2"
                disabled={!canSplit || split.isPending}
                onClick={() => split.mutate(selected)}
              >
                <Scissors size={13} /> 선택한 얼굴 분리
              </Button>
            </section>

            {others.length > 0 ? (
              <section className="mt-5">
                <h3 className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-faint">
                  다른 인물과 합치기
                </h3>
                <div className="flex gap-1.5">
                  <select
                    value={mergeSource}
                    onChange={(event) => setMergeSource(event.target.value)}
                    className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-raised px-2 text-[12.5px] text-ink outline-none focus:border-accent/60"
                  >
                    <option value="">인물 선택</option>
                    {others.map((other) => (
                      <option key={other.id} value={other.id}>
                        {other.name} ({other.faceCount})
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    disabled={!mergeSource || merge.isPending}
                    onClick={() => merge.mutate(mergeSource)}
                  >
                    <GitMerge size={13} /> 합치기
                  </Button>
                </div>
              </section>
            ) : null}

            <section className="mt-5">
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-faint">
                나오는 영상
              </h3>
              <ul className="space-y-1.5">
                {(assets.data?.assets ?? []).map((asset) => (
                  <li key={asset.assetId}>
                    <button
                      type="button"
                      onClick={() => openAsset(asset.assetId, null)}
                      className="flex w-full items-center gap-2.5 rounded-lg border border-line/60 p-1.5 text-left transition-colors hover:bg-raised/70"
                    >
                      <img
                        src={asset.thumbnailUrl ?? ''}
                        alt=""
                        loading="lazy"
                        className="h-[42px] w-[74px] shrink-0 rounded object-cover"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] text-ink">{asset.filename}</span>
                        <span className="block text-[11px] text-faint">
                          얼굴 {asset.faceCount}개 · {formatDuration(asset.durationMs)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </aside>
    </div>
  )
}
