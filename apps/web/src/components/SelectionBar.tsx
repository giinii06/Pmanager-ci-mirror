import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CheckSquare,
  Copy,
  Download,
  FolderInput,
  Image as ImageIcon,
  Sparkles,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import type { AssetQuery, BulkOperationKind, BulkSelection } from '@mediavault/shared'
import { cn } from '../lib/cn'
import { useSelection } from '../store/selection'
import { BulkActionDialog } from './BulkActionDialog'
import { Button } from './ui/Button'

const ACTIONS: Array<{ kind: BulkOperationKind; label: string; Icon: typeof Tag; danger?: boolean }> = [
  { kind: 'tag_add', label: '태그', Icon: Tag },
  { kind: 'poster', label: '포스터', Icon: ImageIcon },
  { kind: 'reanalyze', label: '재분석', Icon: Sparkles },
  { kind: 'move', label: '이동', Icon: FolderInput },
  { kind: 'copy', label: '복사', Icon: Copy },
  { kind: 'export', label: '내보내기', Icon: Download },
  { kind: 'delete', label: '삭제', Icon: Trash2, danger: true },
]

/** The query without paging: the server resolves the whole filter at once. */
function selectionQuery(filters: AssetQuery): AssetQuery {
  return {
    ...(filters.libraryId ? { libraryId: filters.libraryId } : {}),
    ...(filters.folderId ? { folderId: filters.folderId } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.tagId ? { tagId: filters.tagId } : {}),
    ...(filters.albumId ? { albumId: filters.albumId } : {}),
    ...(filters.sort ? { sort: filters.sort } : {}),
    ...(filters.seed !== undefined ? { seed: filters.seed } : {}),
    ...(filters.q ? { q: filters.q } : {}),
  }
}

export function SelectionBar({
  filters,
  loadedIds,
}: {
  filters: AssetQuery
  loadedIds: string[]
}) {
  const active = useSelection((state) => state.active)
  const mode = useSelection((state) => state.mode)
  const ids = useSelection((state) => state.ids)
  const query = useSelection((state) => state.query)
  const addMany = useSelection((state) => state.addMany)
  const selectQuery = useSelection((state) => state.selectQuery)
  const clear = useSelection((state) => state.clear)
  const stop = useSelection((state) => state.stop)
  const [action, setAction] = useState<BulkOperationKind | null>(null)
  const navigate = useNavigate()

  if (!active) return null

  const selection: BulkSelection | null =
    mode === 'query' && query
      ? { kind: 'query', query: selectionQuery(query) }
      : ids.length > 0
        ? { kind: 'ids', assetIds: ids }
        : null

  return (
    <>
      <div className="sticky top-0 z-20 -mx-6 mb-4 border-y border-line bg-panel/95 px-6 py-2.5 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
            <CheckSquare size={15} className="text-accent" />
            {mode === 'query'
              ? '조건에 맞는 모든 파일'
              : `${ids.length.toLocaleString()}개 선택`}
          </span>

          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => addMany(loadedIds)}
              disabled={mode === 'query' || loadedIds.length === 0}
            >
              화면 전체
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => selectQuery(filters)}
              disabled={mode === 'query'}
            >
              조건 전체
            </Button>
            <Button size="sm" variant="ghost" onClick={clear} disabled={ids.length === 0 && mode === 'ids'}>
              선택 해제
            </Button>
          </div>

          <div className="mx-1 hidden h-5 w-px bg-line sm:block" />

          <div className="flex flex-wrap items-center gap-1">
            {ACTIONS.map(({ kind, label, Icon, danger }) => (
              <Button
                key={kind}
                size="sm"
                variant={danger ? 'danger' : 'secondary'}
                disabled={selection === null}
                onClick={() => setAction(kind)}
                className={cn(danger && 'border-[#4a2a2e]')}
              >
                <Icon size={13} />
                {label}
              </Button>
            ))}
          </div>

          <button
            type="button"
            onClick={stop}
            aria-label="선택 모드 닫기"
            className="ml-auto rounded-md p-1.5 text-muted transition-colors hover:bg-raised hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>
        {mode === 'ids' && ids.length > 0 ? (
          <p className="mt-1 text-[11.5px] text-faint">
            타일을 누르면 선택이 바뀝니다. 다른 화면으로 이동하면 선택이 풀립니다.
          </p>
        ) : null}
      </div>

      <BulkActionDialog
        open={action !== null}
        kind={action}
        selection={selection}
        onClose={() => setAction(null)}
        onCreated={(operationId) => {
          setAction(null)
          stop()
          navigate(`/bulk/${operationId}`)
        }}
      />
    </>
  )
}
