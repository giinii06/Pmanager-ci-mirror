import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Info } from 'lucide-react'
import type { SmartAlbumDTO, VideoSort } from '@mediavault/shared'
import { api } from '../lib/api'
import {
  EMPTY_DRAFT,
  draftFromTree,
  draftProblems,
  draftRuleCount,
  treeFromDraft,
  type FilterDraft,
} from '../lib/filterTree'
import { useUi } from '../store/ui'
import { FilterBuilder } from './FilterBuilder'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import { Input } from './ui/Input'

const SORT_CHOICES: Array<{ value: VideoSort | ''; label: string }> = [
  { value: '', label: '기본' },
  { value: 'latest', label: '최신순' },
  { value: 'name', label: '이름순' },
  { value: 'views', label: '조회수순' },
  { value: 'watch_time', label: '시청시간순' },
  { value: 'votes', label: 'Vote순' },
  { value: 'rate', label: '평점순' },
]

const SELECT =
  'h-9 w-full rounded-lg border border-line bg-panel-2 px-2.5 text-[13px] text-ink transition-colors hover:border-line-strong focus:border-accent/60 focus:outline-none'

function draftFor(album: SmartAlbumDTO | null | undefined, seed: FilterDraft | undefined): {
  draft: FilterDraft
  notice: string | null
} {
  if (!album) return { draft: seed ?? EMPTY_DRAFT, notice: null }
  if (!album.filter.valid) {
    return {
      draft: EMPTY_DRAFT,
      notice: `저장된 조건을 읽을 수 없습니다 (${album.filter.error}). 조건을 새로 만들면 그대로 덮어씁니다.`,
    }
  }
  const decoded = draftFromTree(album.filter.tree)
  if (!decoded) {
    return {
      draft: EMPTY_DRAFT,
      notice: '저장된 조건이 이 편집기보다 복잡합니다. 새로 저장하면 지금 화면의 조건으로 덮어씁니다.',
    }
  }
  return { draft: decoded, notice: null }
}

export function AlbumDialog({
  open,
  onClose,
  album,
  initialDraft,
  initialSort,
}: {
  open: boolean
  onClose: () => void
  album?: SmartAlbumDTO | null
  initialDraft?: FilterDraft
  initialSort?: VideoSort | null
}) {
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const seedRef = useRef({ draft: initialDraft, sort: initialSort })
  seedRef.current = { draft: initialDraft, sort: initialSort }
  const albumRef = useRef(album)
  albumRef.current = album

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [sort, setSort] = useState<VideoSort | ''>('')
  const [pinned, setPinned] = useState(false)
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_DRAFT)
  const [notice, setNotice] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const albumId = album?.id ?? null

  // Opening resets the form from the album being edited, never from a refetch,
  // so a background refresh cannot wipe what the user has typed.
  useEffect(() => {
    if (!open) return
    const current = albumRef.current ?? null
    const seeded = draftFor(current, seedRef.current.draft)
    setName(current?.name ?? '')
    setDescription(current?.description ?? '')
    setSort(current?.sort ?? seedRef.current.sort ?? '')
    setPinned(current?.pinned ?? false)
    setDraft(seeded.draft)
    setNotice(seeded.notice)
    setSubmitError(null)
  }, [open, albumId])

  const problems = useMemo(() => draftProblems(draft), [draft])
  const ruleCount = draftRuleCount(draft)
  const tree = useMemo(() => (problems.length === 0 ? treeFromDraft(draft) : null), [draft, problems])
  const canSave = name.trim().length > 0 && tree !== null

  const save = useMutation({
    mutationFn: async () => {
      if (!tree) throw new Error('조건을 하나 이상 채우세요.')
      const trimmedName = name.trim()
      const trimmedDescription = description.trim()
      const common = {
        name: trimmedName,
        filter: tree,
        sort: sort === '' ? null : sort,
        pinned,
      }
      // Create rejects `description: null`; update needs the null to clear it.
      return albumId
        ? api.updateSmartAlbum(albumId, {
            ...common,
            description: trimmedDescription ? trimmedDescription : null,
          })
        : api.createSmartAlbum({
            ...common,
            ...(trimmedDescription ? { description: trimmedDescription } : {}),
          })
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['smart-albums'] })
      queryClient.invalidateQueries({ queryKey: ['smart-album', saved.id] })
      queryClient.invalidateQueries({ queryKey: ['assets'] })
      toast(albumId ? '앨범을 수정했습니다.' : '앨범을 만들었습니다.', 'success')
      onClose()
    },
    onError: (error) => {
      setSubmitError(error instanceof Error ? error.message : '앨범을 저장하지 못했습니다.')
    },
  })

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={albumId ? '스마트 앨범 수정' : '스마트 앨범 만들기'}
      description="조건을 저장할 뿐, 파일을 옮기거나 복사하지 않습니다."
      className="w-[min(760px,94vw)]"
      footer={
        <>
          <Button onClick={onClose}>취소</Button>
          <Button
            variant="primary"
            disabled={!canSave || save.isPending}
            onClick={() => {
              setSubmitError(null)
              save.mutate()
            }}
          >
            {save.isPending ? '저장 중' : albumId ? '수정 저장' : '앨범 만들기'}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-ink">이름</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="예: 올해 본 영화"
            maxLength={80}
            autoFocus
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-ink">설명 (선택)</span>
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="이 앨범이 모으는 것"
            maxLength={500}
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ink">정렬</span>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as VideoSort | '')}
              className={SELECT}
            >
              {SORT_CHOICES.map((choice) => (
                <option key={choice.value || 'default'} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-end gap-2 pb-2">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(event) => setPinned(event.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            <span className="text-[12.5px] text-ink">목록 위에 고정</span>
          </label>
        </div>

        {notice ? (
          <p className="flex items-start gap-1.5 rounded-lg border border-[#f59e0b]/30 bg-[#f59e0b]/10 px-3 py-2 text-[11.5px] leading-relaxed text-[#fbbf24]">
            <Info size={13} className="mt-0.5 shrink-0" />
            {notice}
          </p>
        ) : null}

        <FilterBuilder draft={draft} problems={problems} onChange={setDraft} />

        {ruleCount === 0 ? (
          <p className="text-[11.5px] text-faint">조건을 하나 이상 추가해야 저장할 수 있습니다.</p>
        ) : null}

        {submitError ? (
          <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] leading-relaxed text-danger">
            {submitError}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
