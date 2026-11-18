import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronRight,
  Folder,
  HardDrive,
  Search,
} from 'lucide-react'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { formatBytes } from '../lib/format'
import { useDebounced } from '../lib/hooks'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Spinner } from './ui/Spinner'

interface HostFolderPickerProps {
  selectedPath: string
  onSelect: (rootPath: string, suggestedName?: string) => void
}

function suggestedFolderName(rootPath: string): string {
  const seg = rootPath.split('/').filter(Boolean).pop() ?? ''
  if (/^[a-z]$/i.test(seg)) return `${seg.toUpperCase()} 드라이브`
  return seg
}

export function HostFolderPicker({ selectedPath, onSelect }: HostFolderPickerProps) {
  const [browsePath, setBrowsePath] = useState('')
  const [history, setHistory] = useState<string[]>([''])
  const [historyIndex, setHistoryIndex] = useState(0)
  const [filterText, setFilterText] = useState('')
  const debouncedFilter = useDebounced(filterText.trim(), 180)

  const drivesQuery = useQuery({
    queryKey: ['fs', 'drives'],
    queryFn: api.fsDrives,
    staleTime: 30_000,
  })

  const browseQuery = useQuery({
    queryKey: ['fs', 'browse', browsePath, debouncedFilter],
    queryFn: () => api.fsBrowse(browsePath, debouncedFilter),
    staleTime: 10_000,
  })

  useEffect(() => {
    if (!selectedPath) return
    if (browsePath === '' && selectedPath.includes('/')) {
      setBrowsePath(selectedPath)
    }
  }, [selectedPath])

  const navigateTo = (target: string) => {
    if (target === browsePath) return
    const nextHistory = history.slice(0, historyIndex + 1)
    nextHistory.push(target)
    setHistory(nextHistory)
    setHistoryIndex(nextHistory.length - 1)
    setBrowsePath(target)
    setFilterText('')
  }

  const canBack = historyIndex > 0
  const canForward = historyIndex < history.length - 1
  const data = browseQuery.data

  const goBack = () => {
    if (!canBack) return
    const idx = historyIndex - 1
    setHistoryIndex(idx)
    setBrowsePath(history[idx] ?? '')
  }

  const goForward = () => {
    if (!canForward) return
    const idx = historyIndex + 1
    setHistoryIndex(idx)
    setBrowsePath(history[idx] ?? '')
  }

  const selectFolder = (pathValue: string) => {
    onSelect(pathValue, suggestedFolderName(pathValue))
  }

  return (
    <div className="space-y-2.5 rounded-xl border border-line bg-panel-2/70 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={goBack}
          disabled={!canBack}
          aria-label="뒤로"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-line bg-panel text-muted transition-colors hover:text-ink disabled:opacity-40"
        >
          <ArrowLeft size={13} />
        </button>
        <button
          type="button"
          onClick={goForward}
          disabled={!canForward}
          aria-label="앞으로"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-line bg-panel text-muted transition-colors hover:text-ink disabled:opacity-40"
        >
          <ArrowRight size={13} />
        </button>
        <button
          type="button"
          onClick={() => {
            if (data?.parentPath !== null && data?.parentPath !== undefined) {
              navigateTo(data.parentPath)
            }
          }}
          disabled={!data || data.parentPath === null}
          aria-label="상위 폴더"
          className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-panel px-2 text-[11.5px] text-muted transition-colors hover:text-ink disabled:opacity-40"
        >
          <ArrowUp size={12} />
          상위
        </button>

        <div className="relative min-w-[160px] flex-1">
          <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
            placeholder="현재 폴더 검색..."
            className="h-7 pl-7 text-[12px]"
          />
        </div>
      </div>

      {drivesQuery.data?.drives.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => navigateTo('')}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11.5px] font-medium transition-colors',
              browsePath === ''
                ? 'border-accent/50 bg-accent/12 text-accent'
                : 'border-line bg-panel text-muted hover:text-ink',
            )}
          >
            <HardDrive size={11} />
            내 컴퓨터
          </button>
          {drivesQuery.data.drives.map((drive) => {
            const active = browsePath === drive.rootPath || browsePath.startsWith(`${drive.rootPath}/`)
            return (
              <button
                key={drive.id}
                type="button"
                onClick={() => navigateTo(drive.rootPath)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] transition-colors',
                  active
                    ? 'border-accent/50 bg-accent/12 text-accent'
                    : 'border-line bg-panel text-muted hover:text-ink',
                )}
              >
                <span className="font-medium">{drive.label}</span>
                {drive.freeBytes !== null ? (
                  <span className="text-[10px] text-faint">{formatBytes(drive.freeBytes)} 여유</span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1 text-[11.5px] text-muted">
        {(data?.breadcrumbs ?? [{ name: '내 컴퓨터', path: '' }]).map((crumb, index) => (
          <span key={`${crumb.path}-${index}`} className="inline-flex items-center gap-1">
            {index > 0 ? <ChevronRight size={11} className="text-faint" /> : null}
            <button
              type="button"
              onClick={() => navigateTo(crumb.path)}
              className="rounded px-1 py-0.5 hover:bg-panel hover:text-ink"
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </div>

      <div className="max-h-52 overflow-y-auto overscroll-contain rounded-lg border border-line bg-panel">
        {browseQuery.isPending ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : browseQuery.isError ? (
          <p className="px-3 py-6 text-center text-[12px] text-danger">
            {browseQuery.error instanceof Error
              ? browseQuery.error.message
              : '폴더 목록을 읽을 수 없습니다.'}
          </p>
        ) : data && data.folders.length > 0 ? (
          <ul className="divide-y divide-line/60">
            {data.folders.map((entry) => {
              const isSelected = selectedPath === entry.path
              return (
                <li
                  key={entry.path}
                  className={cn(
                    'flex items-center gap-2 px-2.5 py-1.5 text-[12.5px] transition-colors',
                    isSelected ? 'bg-accent/10 text-ink' : 'hover:bg-raised/60',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => selectFolder(entry.path)}
                    onDoubleClick={() => navigateTo(entry.path)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <Folder
                      size={14}
                      className={isSelected ? 'shrink-0 text-accent' : 'shrink-0 text-faint'}
                    />
                    <span className="truncate font-medium text-ink">{entry.name}</span>
                    {isSelected ? <Check size={13} className="shrink-0 text-accent" /> : null}
                  </button>

                  {entry.hasChildren ? (
                    <button
                      type="button"
                      onClick={() => navigateTo(entry.path)}
                      className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-raised hover:text-ink"
                    >
                      열기
                      <ChevronRight size={12} />
                    </button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="px-3 py-6 text-center text-[12px] text-faint">표시할 하위 폴더가 없습니다.</p>
        )}
      </div>

      {browsePath !== '' ? (
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <p className="min-w-0 truncate text-[11.5px] text-muted">
            현재 위치: <span className="font-mono text-ink">{browsePath}</span>
          </p>
          <Button
            size="sm"
            variant={selectedPath === browsePath ? 'primary' : undefined}
            onClick={() => selectFolder(browsePath)}
          >
            <Check size={12} />
            이 폴더 지정
          </Button>
        </div>
      ) : null}
    </div>
  )
}
