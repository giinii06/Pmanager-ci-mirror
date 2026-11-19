import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Loader2 } from 'lucide-react'
import {
  AI_STAGES,
  type AiStage,
  type BulkOperationKind,
  type BulkSelection,
} from '@mediavault/shared'
import { ApiError, api } from '../lib/api'
import { BULK_KIND_LABEL } from '../lib/bulk'
import { formatBytes, formatCount } from '../lib/format'
import { randomToken } from '../lib/random'
import { useUi } from '../store/ui'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import { Input } from './ui/Input'

const STAGE_LABEL: Record<AiStage, string> = {
  transcript: '자막',
  scenes: '장면',
  translation: '번역',
  embedding: '임베딩',
}

const BLOCKING = new Set([
  'no_assets',
  'selection_too_large',
  'mutation_engine_disabled',
  'target_required',
  'target_missing',
  'target_folder_invalid',
  'target_offline',
  'tag_required',
  'tag_missing',
  'params_invalid',
])

const SELECT =
  'h-9 w-full rounded-lg border border-line bg-panel-2 px-2.5 text-[13px] text-ink transition-colors hover:border-line-strong focus:border-accent/60 focus:outline-none'

export function BulkActionDialog({
  open,
  kind,
  selection,
  onClose,
  onCreated,
}: {
  open: boolean
  kind: BulkOperationKind | null
  selection: BulkSelection | null
  onClose: () => void
  onCreated: (operationId: string) => void
}) {
  const toast = useUi((state) => state.toast)
  const [tagId, setTagId] = useState('')
  const [tagName, setTagName] = useState('')
  const [targetLibraryId, setTargetLibraryId] = useState('')
  const [targetFolder, setTargetFolder] = useState('')
  const [stages, setStages] = useState<AiStage[]>([...AI_STAGES])
  const [confirmText, setConfirmText] = useState('')

  useEffect(() => {
    if (!open) return
    setTagId('')
    setTagName('')
    setTargetLibraryId('')
    setTargetFolder('')
    setStages([...AI_STAGES])
    setConfirmText('')
  }, [open, kind])

  const tagsQuery = useQuery({
    queryKey: ['tags'],
    queryFn: api.tags,
    enabled: open && (kind === 'tag_add' || kind === 'tag_remove'),
  })
  const librariesQuery = useQuery({
    queryKey: ['libraries'],
    queryFn: api.libraries,
    enabled: open && (kind === 'move' || kind === 'copy'),
  })

  const params = useMemo(() => {
    if (!kind) return {}
    if (kind === 'tag_add') {
      return tagId ? { tagId } : tagName.trim() ? { tagName: tagName.trim() } : {}
    }
    if (kind === 'tag_remove') return tagId ? { tagId } : {}
    if (kind === 'move' || kind === 'copy') {
      return {
        ...(targetLibraryId ? { targetLibraryId } : {}),
        targetFolder: targetFolder.trim(),
      }
    }
    if (kind === 'reanalyze') return { stages }
    if (kind === 'delete') return { confirm: 'delete' as const }
    return {}
  }, [kind, tagId, tagName, targetLibraryId, targetFolder, stages])

  const ready =
    kind === 'tag_add'
      ? Boolean(tagId || tagName.trim())
      : kind === 'tag_remove'
        ? Boolean(tagId)
        : kind === 'move' || kind === 'copy'
          ? Boolean(targetLibraryId)
          : kind === 'reanalyze'
            ? stages.length > 0
            : kind !== null

  const paramsKey = JSON.stringify(params)
  const preview = useQuery({
    queryKey: ['bulk-preview', kind, selection, paramsKey],
    queryFn: () => api.bulkPreview({ kind: kind!, selection: selection!, params }),
    enabled: open && kind !== null && selection !== null && ready,
    retry: false,
    staleTime: 0,
  })

  const create = useMutation({
    mutationFn: () =>
      api.createBulkOperation({
        kind: kind!,
        selection: selection!,
        params,
        requestId: randomToken(),
        generation: preview.data!.generation,
        expectedCount: preview.data!.count,
      }),
    onSuccess: (result) => {
      toast(
        result.created ? '일괄 작업을 시작했습니다.' : '이미 접수된 요청입니다. 진행 상황을 엽니다.',
        'success',
      )
      onCreated(result.operationId)
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'selection_changed') {
        void preview.refetch()
        toast('선택 결과가 미리보기와 달라졌습니다. 다시 확인해 주세요.', 'error')
        return
      }
      toast(error instanceof Error ? error.message : '일괄 작업을 시작하지 못했습니다.', 'error')
    },
  })

  const problems = preview.data?.problems ?? []
  const blocking = problems.filter((problem) => BLOCKING.has(problem.code))
  const deleteReady = kind !== 'delete' || confirmText.trim().toLowerCase() === 'delete'
  const canStart =
    preview.data !== undefined &&
    blocking.length === 0 &&
    deleteReady &&
    !create.isPending &&
    selection !== null

  const tags = tagsQuery.data?.tags ?? []
  const libraries = librariesQuery.data ?? []

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={kind ? BULK_KIND_LABEL[kind] : '일괄 작업'}
      description={
        selection?.kind === 'query'
          ? '현재 조건에 맞는 모든 파일을 대상으로 미리 확인합니다.'
          : '선택한 파일을 대상으로 미리 확인합니다.'
      }
      className="w-[min(560px,94vw)]"
      footer={
        <>
          <Button onClick={onClose}>취소</Button>
          <Button
            variant={kind === 'delete' ? 'danger' : 'primary'}
            disabled={!canStart}
            onClick={() => create.mutate()}
          >
            {create.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
            {kind === 'delete' ? '영구 삭제 시작' : '작업 시작'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {kind === 'tag_add' || kind === 'tag_remove' ? (
          <div className="space-y-2">
            <label className="block text-[12px] font-medium text-muted">
              {kind === 'tag_add' ? '붙일 태그' : '뗄 태그'}
            </label>
            <select
              value={tagId}
              onChange={(event) => setTagId(event.target.value)}
              className={SELECT}
            >
              <option value="">태그 선택</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
            {kind === 'tag_add' ? (
              <Input
                value={tagName}
                onChange={(event) => setTagName(event.target.value)}
                placeholder="또는 새 태그 이름"
                className="h-9"
              />
            ) : null}
          </div>
        ) : null}

        {kind === 'move' || kind === 'copy' ? (
          <div className="space-y-2">
            <label className="block text-[12px] font-medium text-muted">대상 라이브러리</label>
            <select
              value={targetLibraryId}
              onChange={(event) => setTargetLibraryId(event.target.value)}
              className={SELECT}
            >
              <option value="">라이브러리 선택</option>
              {libraries.map((library) => (
                <option key={library.id} value={library.id}>
                  {library.name}
                </option>
              ))}
            </select>
            <label className="block text-[12px] font-medium text-muted">대상 폴더</label>
            <Input
              value={targetFolder}
              onChange={(event) => setTargetFolder(event.target.value)}
              placeholder="비우면 라이브러리 루트 (예: 2026/여행)"
              className="h-9"
            />
          </div>
        ) : null}

        {kind === 'reanalyze' ? (
          <div className="space-y-2">
            <span className="block text-[12px] font-medium text-muted">다시 실행할 단계</span>
            <div className="flex flex-wrap gap-1.5">
              {AI_STAGES.map((stage) => {
                const on = stages.includes(stage)
                return (
                  <button
                    key={stage}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setStages((current) =>
                        current.includes(stage)
                          ? current.filter((value) => value !== stage)
                          : [...current, stage],
                      )
                    }
                    className={
                      on
                        ? 'h-8 rounded-lg border border-accent/50 bg-accent/15 px-2.5 text-[12px] font-medium text-accent'
                        : 'h-8 rounded-lg border border-line bg-panel text-[12px] text-muted hover:border-line-strong hover:text-ink'
                    }
                  >
                    {STAGE_LABEL[stage]}
                  </button>
                )
              })}
            </div>
            <p className="text-[11.5px] text-faint">
              완료된 산출물도 강제로 다시 만듭니다. 원본 파일은 바뀌지 않습니다.
            </p>
          </div>
        ) : null}

        {kind === 'delete' ? (
          <div className="space-y-2 rounded-lg border border-[#4a2a2e] bg-[#2a1719]/60 p-3">
            <p className="flex items-start gap-2 text-[12.5px] text-[#ffb4b4]">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              원본 파일을 휴지통 없이 영구 삭제합니다. 되돌릴 수 없습니다.
            </p>
            <Input
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              placeholder="계속하려면 delete 를 입력하세요"
              className="h-9"
            />
          </div>
        ) : null}

        {kind === 'export' ? (
          <p className="text-[12.5px] text-muted">
            선택한 파일의 이름·경로·크기를 CSV로 저장합니다. 파일은 바뀌지 않습니다.
          </p>
        ) : null}

        <div className="rounded-lg border border-line bg-panel-2 p-3">
          {!ready ? (
            <p className="text-[12.5px] text-muted">대상과 옵션을 고르면 미리 확인합니다.</p>
          ) : preview.isPending ? (
            <p className="flex items-center gap-2 text-[12.5px] text-muted">
              <Loader2 size={14} className="animate-spin" />
              미리 확인하는 중
            </p>
          ) : preview.isError ? (
            <p className="text-[12.5px] text-[#ff9c9c]">
              {preview.error instanceof Error ? preview.error.message : '미리보기를 불러오지 못했습니다.'}
            </p>
          ) : preview.data ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-[13px] font-medium text-ink">
                  {formatCount(preview.data.count)}개 파일
                </span>
                <span className="text-[12px] text-muted">{formatBytes(preview.data.totalBytes)}</span>
              </div>
              {preview.data.sample.length > 0 ? (
                <ul className="space-y-0.5 text-[11.5px] text-muted">
                  {preview.data.sample.map((sample) => (
                    <li key={sample.assetId} className="truncate">
                      {sample.relativePath}
                    </li>
                  ))}
                  {preview.data.count > preview.data.sample.length ? (
                    <li className="text-faint">
                      외 {formatCount(preview.data.count - preview.data.sample.length)}개
                    </li>
                  ) : null}
                </ul>
              ) : null}
              {problems.length > 0 ? (
                <ul className="space-y-1 border-t border-line pt-2">
                  {problems.map((problem) => (
                    <li
                      key={`${problem.code}:${problem.count}`}
                      className={
                        BLOCKING.has(problem.code)
                          ? 'flex items-start gap-1.5 text-[12px] text-[#ffb4b4]'
                          : 'flex items-start gap-1.5 text-[12px] text-[#e8c77a]'
                      }
                    >
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                      <span>
                        {problem.message}
                        {problem.count > 0 ? ` (${formatCount(problem.count)}개)` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {blocking.length === 0 ? (
                <p className="text-[11.5px] text-faint">
                  시작하면 파일별로 처리하고, 실패한 항목은 진행 화면에서 다시 시도할 수 있습니다.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </Dialog>
  )
}
